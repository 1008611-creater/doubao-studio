/**
 * main/main.ts
 * Electron 主进程入口
 *
 * 职责：
 * 1. 创建应用窗口
 * 2. 注册 IPC 通信模块
 * 3. 管理 webview 标签（多账号隔离浏览器）
 * 4. 窗口生命周期管理
 */

import { app, BrowserWindow, ipcMain, session, shell, webContents } from 'electron';
import * as path from 'path';
import { registerAccountIPC } from './ipc/accounts';
import { registerTaskIPC } from './ipc/tasks';
import { registerProjectIPC } from './ipc/projects';
import { registerSystemIPC } from './ipc/system';
import { writeCrashLog } from './utils/logger';
import { replaceIpcHandlers } from './ipc/lifecycle';
import { readJSON } from './utils/store';

// ==================== 常量 ====================

const isDev = !app.isPackaged;
const PRELOAD_PATH = path.join(__dirname, 'preload.js');

/** 豆包网页地址 */
const DOUBAO_URL = 'https://www.doubao.com';
/** 用户提供的扩展目录；仅交给 Electron 加载，不读取扩展内容。 */
const USER_EXTENSION_PATH = 'C:\\Users\\lsb\\Downloads\\加密扩展\\jiami';

// ==================== 下载链路诊断日志 ====================
// 统一记录扩展按钮 -> 主进程 IPC 的端到端轨迹，便于定位断点。
// 日志只含 reqId / 边界名 / 账号分区 / 是否有 URL / 状态码 / 错误，禁止输出完整媒体地址。

// 下载链路诊断日志说明见下方。GPU 绕过不在代码里硬编码：
// 需要绕过 GPU 的环境（如无显卡/远程会话）由启动器（bat/快捷方式）传入
// --in-process-gpu --use-gl=swiftshader 等参数控制，避免与代码内 appendSwitch 冲突导致闪退。

type TraceEntry = {
  ts: string;
  rid: string;        // 请求编号（6 位短随机）
  bn: string;         // 边界名：ipc-in / fetch-start / fetch-done / queue-poll / ipc-call / console-capture / ext-msg / ext-click / ext-sendmsg / ext-bridge
  pt?: string;        // 账号分区
  hu?: 0 | 1;         // 是否有 URL（0/1，不输出原值）
  sc?: number;        // HTTP 状态码
  e?: string;         // 错误信息
  extra?: Record<string, unknown>;
};

// 全局下载去重表：用于 downloadWithAccountSession 和 webContentsDownload 两个下载通道。
// 抖音/豆包视频 URL 每次签名 token 不同（pathname hash 段变），所以 pathname-based fingerprint 失效。
// 改用 Content-Length（fetch 响应头）作为指纹：同一视频无论 URL 怎么变，CDN 返回的 Content-Length 稳定。
const recentDownloadAttempts = new Map<string, number>(); // key = partition::contentLength, value = timestamp
const recentCompletedSizes = new Map<string, number>();   // key = partition::contentLength, value = 完成时间（用于后置删冗余）

function newRid(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

function getTraceLogPath(): string {
  const dataDir = path.join(app.getPath('userData'), 'DoubaoStudioData');
  try {
    const fs = require('fs');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  } catch {}
  return path.join(dataDir, 'download-trace.log');
}

function writeTraceLog(entry: Omit<TraceEntry, 'ts'> & { ts?: string }): void {
  const line: TraceEntry = {
    ts: entry.ts ?? new Date().toISOString(),
    rid: entry.rid || '-',
    bn: entry.bn,
    pt: entry.pt,
    hu: entry.hu,
    sc: entry.sc,
    e: entry.e,
    extra: entry.extra,
  };
  const text = JSON.stringify(line);
  try {
    const fs = require('fs');
    fs.appendFileSync(getTraceLogPath(), text + '\n', 'utf-8');
  } catch (error) {
    console.warn('[D-TRACE] writeTraceLog failed', error instanceof Error ? error.message : String(error));
  }
  // 同步输出到 stderr，便于开发期 devtools 或 debug.log 查看
  process.stderr.write(`[D-TRACE] ${text}\n`);
}

// ==================== 全局状态 ====================

let mainWindow: BrowserWindow | null = null;
/** 应用是否正在退出，防止退出过程中创建新窗口或重新调度任务 */
let isQuitting = false;
let unregisterIPC: (() => void) | null = null;
const extensionPopupWindows = new Map<string, BrowserWindow>();
const downloadHandlers = new WeakSet<Electron.Session>();
type BrowserDownloadRecord = { id: string; filename: string; filePath: string; state: string; receivedBytes: number; totalBytes: number; startedAt: string; error?: string };
const browserDownloads: BrowserDownloadRecord[] = [];
const observedDownloadFiles = new Set<string>();

function registerObservedDownload(filePath: string): void {
  const fs = require('fs');
  if (observedDownloadFiles.has(filePath) || !fs.existsSync(filePath)) return;
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size === 0) return;
  observedDownloadFiles.add(filePath);
  if (browserDownloads.some((item) => item.filePath === filePath)) return;
  const record: BrowserDownloadRecord = {
    id: `observed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    filename: path.basename(filePath), filePath, state: 'completed',
    receivedBytes: stat.size, totalBytes: stat.size, startedAt: stat.birthtime.toISOString(),
  };
  browserDownloads.unshift(record);
  browserDownloads.splice(50);
  mainWindow?.webContents.send('browser-download-updated', { ...record });
}

function watchSystemDownloads(): void {
  const fs = require('fs');
  const downloadDir = app.getPath('downloads');
  try {
    for (const entry of fs.readdirSync(downloadDir)) {
      const full = path.join(downloadDir, entry);
      if (/\.(mp4|mov|webm|m4v|zip|rar|png|jpe?g)$/i.test(entry)) registerObservedDownload(full);
    }
    fs.watch(downloadDir, (_event: string, filename: string | Buffer) => {
      if (!filename) return;
      const name = filename.toString();
      if (/\.(mp4|mov|webm|m4v|zip|rar|png|jpe?g)$/i.test(name)) {
        setTimeout(() => registerObservedDownload(path.join(downloadDir, name)), 800);
      }
    });
  } catch (error) {
    console.warn('[Download] 无法监测系统下载目录', error instanceof Error ? error.message : String(error));
  }
}

function attachBrowserDownloadHandler(targetSession: Electron.Session): void {
  if (downloadHandlers.has(targetSession)) return;
  targetSession.on('will-download', (_event, item) => {
    const downloadDir = path.join(app.getPath('downloads'), '豆包工作室浏览器下载');
    const fs = require('fs');
    fs.mkdirSync(downloadDir, { recursive: true });
    // 优先使用 webContents.downloadURL 传入的 filename，否则从 URL 提取，最后兜底用 suggest
    const fromUrl = (() => {
      try { return decodeURIComponent(path.basename(new URL(item.getURL()).pathname)); } catch { return ''; }
    })();
    const suggested = (item as unknown as { getSuggestedFilename?: () => string }).getSuggestedFilename?.() || item.getFilename() || fromUrl;
    const filename = makeDownloadFilename(suggested || `download_${Date.now()}`);
    const filePath = path.join(downloadDir, filename);
    const record: BrowserDownloadRecord = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, filename, filePath, state: 'downloading', receivedBytes: 0, totalBytes: item.getTotalBytes(), startedAt: new Date().toISOString() };
    browserDownloads.unshift(record); browserDownloads.splice(50);
    item.setSavePath(filePath);
    const publish = () => { record.receivedBytes = item.getReceivedBytes(); record.totalBytes = item.getTotalBytes(); mainWindow?.webContents.send('browser-download-updated', { ...record }); };
    item.on('updated', publish);
    item.once('done', (_event, state) => { record.state = state; publish(); });
    publish();
  });
  downloadHandlers.add(targetSession);
}

function ensureBrowserDownloadHandler(partition: string): void {
  const key = partition || 'default';
  const targetSession = key === 'default' ? session.defaultSession : session.fromPartition(`persist:doubao_${key}`);
  attachBrowserDownloadHandler(targetSession);
}

function publishBrowserDownload(record: BrowserDownloadRecord): void {
  mainWindow?.webContents.send('browser-download-updated', { ...record });
}

function makeDownloadFilename(value: string | undefined): string {
  const fallback = `doubao_video_${Date.now()}.mp4`;
  const name = (value || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return name || fallback;
}

async function downloadWithAccountSession(partition: string, url: string, filename?: string, rid?: string): Promise<{ success: boolean; error?: string }> {
  const reqId = rid || newRid();
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
    writeTraceLog({ rid: reqId, bn: 'fetch-start', pt: partition, hu: 0, e: '下载地址无效' });
    return { success: false, error: '下载地址无效' };
  }
  const targetSession = partition === 'default' ? session.defaultSession : session.fromPartition(`persist:doubao_${partition}`);
  // 主进程下载去重：抖音/豆包视频 URL 每次签名 token 不同（pathname 的 hash 段变化），
  // 改用 Content-Length 作为指纹——同一视频无论 URL 怎么变，CDN 返回的 Content-Length 稳定。
  // 由于 Content-Length 要 fetch 响应头才知道，先发 HEAD 请求读 size（HEAD 不下载 body，省时省带宽）。
  let contentLength = 0;
  try {
    const headResp = await targetSession.fetch(url, { method: 'HEAD', headers: { Referer: `${DOUBAO_URL}/` } });
    const cl = headResp ? Number(headResp.headers.get('content-length') || 0) : 0;
    if (Number.isFinite(cl) && cl > 0) contentLength = cl;
  } catch (e) { /* HEAD 失败不致命 */ }
  if (contentLength > 0) {
    const dedupKey = `${partition}::${contentLength}`;
    const now = Date.now();
    const last = recentDownloadAttempts.get(dedupKey);
    if (last && now - last < 5000) {
      writeTraceLog({ rid: reqId, bn: 'fetch-dedup', pt: partition, hu: 1, e: `5s 内同 size 已下载/下载中，跳过：${contentLength} bytes` });
      return { success: true, error: 'dedup-skipped' };
    }
    recentDownloadAttempts.set(dedupKey, now);
    if (recentDownloadAttempts.size > 200) {
      for (const [k, t] of recentDownloadAttempts) {
        if (now - t > 5000) recentDownloadAttempts.delete(k);
      }
    }
  }

  const fs = require('fs');
  const downloadDir = path.join(app.getPath('downloads'), '豆包工作室浏览器下载');
  fs.mkdirSync(downloadDir, { recursive: true });

  const record: BrowserDownloadRecord = {
    id: `extension-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    filename: makeDownloadFilename(filename),
    filePath: '',
    state: 'downloading',
    receivedBytes: 0,
    totalBytes: 0,
    startedAt: new Date().toISOString(),
  };
  browserDownloads.unshift(record);
  browserDownloads.splice(50);
  publishBrowserDownload(record);
  writeTraceLog({ rid: reqId, bn: 'fetch-start', pt: partition, hu: 1, extra: { filename: record.filename } });

  try {
    const response = await targetSession.fetch(url, { headers: { Referer: `${DOUBAO_URL}/` } });
    if (!response.ok || !response.body) {
      writeTraceLog({ rid: reqId, bn: 'fetch-done', pt: partition, hu: 1, sc: response.status, e: `服务器返回 ${response.status}` });
      throw new Error(`服务器返回 ${response.status}`);
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > 0) record.totalBytes = contentLength;

    const targetPath = path.join(downloadDir, record.filename);
    // 临时文件带唯一后缀，避免多个并发下载写同一个 .crdownload 导致 rename 冲突（ENOENT）
    const temporaryPath = `${targetPath}.${Math.random().toString(36).slice(2, 8)}.crdownload`;
    record.filePath = targetPath;
    const output = fs.createWriteStream(temporaryPath);
    const reader = response.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const buffer = Buffer.from(chunk.value);
      record.receivedBytes += buffer.length;
      if (!output.write(buffer)) await new Promise<void>((resolve) => output.once('drain', resolve));
      publishBrowserDownload(record);
    }
    await new Promise<void>((resolve, reject) => {
      output.once('error', reject);
      output.end(resolve);
    });
    fs.renameSync(temporaryPath, targetPath);
    record.state = 'completed';
    publishBrowserDownload(record);
    writeTraceLog({ rid: reqId, bn: 'fetch-done', pt: partition, hu: 1, sc: 200, extra: { bytes: record.receivedBytes } });
    return { success: true };
  } catch (error) {
    record.state = 'failed';
    record.error = error instanceof Error ? error.message : String(error);
    publishBrowserDownload(record);
    writeTraceLog({ rid: reqId, bn: 'fetch-done', pt: partition, hu: 1, e: record.error });
    return { success: false, error: record.error };
  }
}

async function loadUserExtension(): Promise<void> {
  const fs = await import('node:fs/promises');
  try {
    await fs.access(path.join(USER_EXTENSION_PATH, 'manifest.json'));
  } catch {
    console.warn('[Extension] 未找到扩展目录或 manifest.json，跳过加载');
    return;
  }

  const accounts = readJSON<Array<{ partition?: string }>>('accounts.json', []);
  const partitions = new Set(
    accounts.map((account) => account.partition).filter((partition): partition is string => Boolean(partition)),
  );
  partitions.add('default');

  for (const partition of partitions) {
    ensureBrowserDownloadHandler(partition);
    await loadUserExtensionForPartition(partition);
  }
}

async function loadUserExtensionForPartition(partition: string): Promise<boolean> {
  try {
    const targetSession = partition === 'default'
      ? session.defaultSession
      : session.fromPartition(`persist:doubao_${partition}`);
    ensureBrowserDownloadHandler(partition);
    const oldExtension = targetSession.getAllExtensions().find((item) => item.path === USER_EXTENSION_PATH);
    if (oldExtension) {
      try {
        await targetSession.removeExtension(oldExtension.id);
        console.log(`[Extension] 已卸载旧版本: ${partition}`);
      } catch (error) {
        console.warn(`[Extension] 卸载旧版本失败: ${partition}`, error instanceof Error ? error.message : String(error));
      }
    }
    await targetSession.loadExtension(USER_EXTENSION_PATH, { allowFileAccess: true });
    console.log(`[Extension] 已加载到浏览器会话: ${partition}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Extension] 会话加载失败: ${partition}`, message);
    writeCrashLog('extensionLoadFailure', `${partition}: ${message}`);
    return false;
  }
}

// ==================== 窗口创建 ====================

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: '豆包工作室 Doubao Studio',
    backgroundColor: '#0f0f14',
    show: true, // 启动即显示；内嵌网页加载失败时仍可操作和查看错误状态
    frame: false, // 无边框窗口（自定义标题栏）
    titleBarStyle: 'hidden', // macOS 隐藏原生标题栏
    webPreferences: {
      preload: PRELOAD_PATH,
      // 开启 webview 标签支持
      webviewTag: true,
      // 安全策略
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // 需要 preload 访问 Node API
    },
  });

  // 窗口准备好后显示
  win.once('ready-to-show', () => {
    win.show();
    if (isDev) {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // 加载前端页面
  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    // 开发模式：加载 Vite 开发服务器
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    // 生产模式（或未启动 Vite 的开发模式）：加载打包后的文件
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // 在默认浏览器中打开外部链接
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  return win;
}

// ==================== IPC 注册 ====================

function registerIPC(): void {
  unregisterIPC?.();
  // 注册业务模块 IPC
  const disposers = [
    registerAccountIPC(),
    registerProjectIPC(),
    registerTaskIPC(),
    registerSystemIPC(),
  ];

  disposers.push(replaceIpcHandlers(ipcMain, ['system:getVersion']));

  // ---- 系统级 IPC ----

  // 获取应用版本
  ipcMain.handle('system:getVersion', () => {
    return app.getVersion();
  });

  ipcMain.handle('extensions:loadForPartition', async (_event, partition: string) => {
    if (typeof partition !== 'string' || !partition.trim()) return { success: false, error: '无效账号会话' };
    return { success: await loadUserExtensionForPartition(partition.trim()) };
  });
  ipcMain.handle('extensions:status', (_event, partition: string) => {
    if (typeof partition !== 'string' || !partition.trim()) return { success: false, loaded: false };
    const targetSession = session.fromPartition(`persist:doubao_${partition.trim()}`);
    const extension = targetSession.getAllExtensions().find((item) => item.path === USER_EXTENSION_PATH);
    return { success: true, loaded: Boolean(extension), name: extension?.name, id: extension?.id };
  });
  ipcMain.handle('extensions:openPopup', (_event, partition: string) => {
    if (typeof partition !== 'string' || !partition.trim()) return { success: false, error: '无效账号会话' };
    const key = partition.trim();
    const targetSession = session.fromPartition(`persist:doubao_${key}`);
    const extension = targetSession.getAllExtensions().find((item) => item.path === USER_EXTENSION_PATH);
    if (!extension) return { success: false, error: '当前账号扩展尚未加载' };
    const manifest = extension.manifest || {};
    const popup = manifest.action?.default_popup || manifest.browser_action?.default_popup;
    if (typeof popup !== 'string' || !popup.trim()) return { success: false, error: '此扩展没有可打开的弹窗' };
    const existing = extensionPopupWindows.get(key);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return { success: true };
    }
    const popupWindow = new BrowserWindow({
      width: 380,
      height: 620,
      minWidth: 280,
      minHeight: 300,
      title: extension.name || '扩展',
      autoHideMenuBar: true,
      webPreferences: { partition: `persist:doubao_${key}`, contextIsolation: true, nodeIntegration: false },
    });
    extensionPopupWindows.set(key, popupWindow);
    popupWindow.on('closed', () => extensionPopupWindows.delete(key));
    // 弹窗打开时确保 15 秒模式保持开启；只操作可见开关，不读取扩展源码。
    popupWindow.webContents.on('did-finish-load', () => {
      void popupWindow.webContents.executeJavaScript(`(() => {
        const labels = Array.from(document.querySelectorAll('*')).filter((el) => {
          const text = (el.textContent || '').trim();
          return text && text.length < 30 && /15\\s*秒模式|15s模式/i.test(text);
        });
        const label = labels.sort((a, b) => a.children.length - b.children.length)[0];
        if (!label) return 'label-not-found';
        let root = label;
        let control = null;
        for (let i = 0; i < 5 && root; i += 1, root = root.parentElement) {
          control = root.matches?.('[role="switch"], input[type="checkbox"], button')
            ? root
            : root.querySelector?.('[role="switch"], input[type="checkbox"], button');
          if (control) break;
        }
        if (!control) return 'control-not-found';
        const aria = control.getAttribute('aria-checked');
        const inputChecked = typeof control.checked === 'boolean' ? control.checked : null;
        const classText = String(control.className || '').toLowerCase();
        const isOn = aria === 'true' || inputChecked === true || /checked|active|enabled|on/.test(classText);
        if (!isOn) { control.click(); return 'enabled'; }
        return 'already-enabled';
      })()`).catch(() => undefined);
    });
    void popupWindow.loadURL(`${extension.url}/${popup.replace(/^\/+/, '')}`);
    return { success: true };
  });
  ipcMain.handle('browser-downloads:list', () => browserDownloads.map((item) => ({ ...item })));
  ipcMain.handle('browser-downloads:download', async (_event, payload: { partition?: string; url?: string; filename?: string; rid?: string }) => {
    const reqId = (payload && typeof payload.rid === 'string' && payload.rid) ? payload.rid : newRid();
    if (!payload || typeof payload.url !== 'string') {
      writeTraceLog({ rid: reqId, bn: 'ipc-in', pt: payload?.partition, hu: 0, e: '下载参数无效' });
      return { success: false, error: '下载参数无效' };
    }
    writeTraceLog({ rid: reqId, bn: 'ipc-in', pt: payload.partition, hu: 1, extra: { filename: payload.filename } });
    return downloadWithAccountSession(typeof payload.partition === 'string' ? payload.partition : 'default', payload.url, payload.filename, reqId);
  });
  // 走 Electron 原生 will-download 路径（用 webContents 自带会话触发下载，绕过 session.fetch 的 net cache 限制）：
  // 1) webContents.downloadURL(url, { suggestedFilename }) 会触发对应 session 的 will-download；
  // 2) attachBrowserDownloadHandler 已注册 will-download 监听器，写入 `豆包工作室浏览器下载/` 并通过 browser-download-updated 推送 BrowserPanel；
  // 3) 同时通过 webContentsId 锁定账号分区，避免跨账号 URL 错配。
  ipcMain.handle('webcontents:downloadURL', async (_event, payload: { webContentsId?: number; url?: string; filename?: string; rid?: string }) => {
    const reqId = (payload && typeof payload.rid === 'string' && payload.rid) ? payload.rid : newRid();
    if (!payload || typeof payload.url !== 'string') {
      writeTraceLog({ rid: reqId, bn: 'wc-download', hu: 0, e: '下载参数无效' });
      return { success: false, error: '下载参数无效' };
    }
    // 全局去重：与 downloadWithAccountSession 共用同一去重表，按 URL 指纹 3 秒内只下 1 次
    const urlFingerprint = (() => {
      try {
        const u = new URL(payload.url);
        return u.pathname.slice(0, 40) + ':' + (u.searchParams.get('feature_id') || u.searchParams.get('fid') || '');
      } catch { return payload.url.slice(0, 100); }
    })();
    const dedupKey = `wc::${urlFingerprint}`;
    const now = Date.now();
    const last = recentDownloadAttempts.get(dedupKey);
    if (last && now - last < 3000) {
      writeTraceLog({ rid: reqId, bn: 'wc-dedup', hu: 1, e: `3s 内同指纹已下载，跳过` });
      return { success: true, error: 'dedup-skipped' };
    }
    recentDownloadAttempts.set(dedupKey, now);
    let wc: Electron.WebContents | null = null;
    if (typeof payload.webContentsId === 'number') {
      wc = webContents.fromId(payload.webContentsId) || null;
    }
    if (!wc && mainWindow) wc = mainWindow.webContents;
    if (!wc) {
      writeTraceLog({ rid: reqId, bn: 'wc-download', hu: 1, e: '未找到 webContents' });
      return { success: false, error: '未找到 webContents' };
    }
    try {
      writeTraceLog({ rid: reqId, bn: 'wc-download', hu: 1, extra: { filename: payload.filename, webContentsId: wc.id } });
      // Electron 33.4.11 的 webContents.downloadURL 第二个参数是 suggestedFilename 字符串（不是 options 对象）
      (wc as unknown as { downloadURL: (url: string, suggestedFilename?: string) => void }).downloadURL(payload.url, payload.filename);
      return { success: true };
    } catch (error) {
      writeTraceLog({ rid: reqId, bn: 'wc-download', hu: 1, e: error instanceof Error ? error.message : String(error) });
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  // 渲染层转发扩展 / 页面侧诊断日志到统一文件，便于 5 段链路在同一处查看
  ipcMain.handle('download-trace:append', (_event, payload: { bn: string; pt?: string; hu?: 0 | 1; sc?: number; e?: string; rid?: string; extra?: Record<string, unknown> }) => {
    if (!payload || typeof payload.bn !== 'string') return { success: false, error: 'invalid payload' };
    writeTraceLog({ rid: payload.rid || newRid(), bn: payload.bn, pt: payload.pt, hu: payload.hu, sc: payload.sc, e: payload.e, extra: payload.extra });
    return { success: true };
  });
  ipcMain.handle('download-trace:read', () => {
    try {
      const fs = require('fs');
      if (!fs.existsSync(getTraceLogPath())) return { success: true, lines: [] as string[] };
      const content = fs.readFileSync(getTraceLogPath(), 'utf-8');
      return { success: true, lines: content.split(/\r?\n/).filter(Boolean) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('download-trace:clear', () => {
    try {
      const fs = require('fs');
      if (fs.existsSync(getTraceLogPath())) fs.writeFileSync(getTraceLogPath(), '', 'utf-8');
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('browser-downloads:open', async (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) return { success: false };
    const result = await shell.openPath(filePath);
    return { success: !result, error: result || undefined };
  });
  ipcMain.handle('browser-downloads:reveal', (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) return { success: false };
    shell.showItemInFolder(filePath);
    return { success: true };
  });
  ipcMain.handle('browser-downloads:delete', (_event, id: string, removeFile = true) => {
    const index = browserDownloads.findIndex((item) => item.id === id);
    if (index < 0) return { success: false, error: '下载记录不存在' };
    const [record] = browserDownloads.splice(index, 1);
    if (removeFile) {
      try { require('fs').rmSync(record.filePath, { force: true }); } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
    }
    return { success: true };
  });

  // 窗口控制
  const minimizeWindow = (): void => {
    mainWindow?.minimize();
  };

  const toggleMaximizeWindow = (): void => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  };

  const closeWindow = (): void => {
    mainWindow?.close();
  };

  ipcMain.on('window:minimize', minimizeWindow);
  ipcMain.on('window:toggleMaximize', toggleMaximizeWindow);
  ipcMain.on('window:close', closeWindow);

  unregisterIPC = () => {
    for (const dispose of disposers.reverse()) dispose();
    ipcMain.removeListener('window:minimize', minimizeWindow);
    ipcMain.removeListener('window:toggleMaximize', toggleMaximizeWindow);
    ipcMain.removeListener('window:close', closeWindow);
    unregisterIPC = null;
  };

  console.log('[Main] IPC 模块全部注册完成');
}

// ==================== 单实例锁 ====================

/**
 * 防止两个实例同时写数据。
 * requestSingleInstanceLock 返回 false 时说明已有实例在运行，当前进程应立即退出。
 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 已有实例运行，直接退出当前进程
  app.quit();
} else {
  // GPU 绕过由启动器参数控制（见文件顶部说明），此处不再硬编码。
  // 第二实例启动时，聚焦并恢复已有主窗口
  app.on('second-instance', () => {
    if (isQuitting) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      // 窗口最小化时恢复
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
      mainWindow.focus();
    }
  });

  // ==================== 全局异常兜底 ====================

  /**
   * 未捕获的同步异常。
   * 记录日志后退出，避免进程处于不确定状态。
   * 不吞掉致命错误——记录后以非零码退出。
   */
  process.on('uncaughtException', (err: Error) => {
    writeCrashLog('uncaughtException', err.message, err.stack);
    // 给日志写入一点时间后退出
    setImmediate(() => {
      process.exit(1);
    });
  });

  /**
   * 未处理的 Promise 拒绝。
   * 记录日志但不自动退出，因为某些拒绝可能是非致命的（如网络超时）。
   * 开发者可通过日志定位并决定是否需要修复。
   */
  process.on('unhandledRejection', (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    writeCrashLog('unhandledRejection', message, stack);
  });

  // ==================== 应用生命周期 ====================

  app.whenReady().then(async () => {
    watchSystemDownloads();
    app.on('web-contents-created', (_event, contents) => {
      attachBrowserDownloadHandler(contents.session);
      // 兜底：扩展 download-bridge 的 tabs.update 会把 webview 导航到无水印真视频 URL，
      // 若渲染层 will-navigate 未拦截（或拦截失败），主进程在此补一刀：取消导航 + 原生下载。
      contents.on('will-navigate', (navEvent, navUrl) => {
        try {
          if (!/^https?:\/\//i.test(navUrl)) return;
          const isVideoNav = /\.(mp4|webm|m4v|mov)(\?|#|$)/i.test(navUrl)
            || /mime_type=video_mp4|download=true|lr=video_gen_no_watermark|video_gen_no_watermark/i.test(navUrl)
            || /idouyinvod\.com|douyinvod\.com/i.test(navUrl);
          if (!isVideoNav) return;
          navEvent.preventDefault();
          writeTraceLog({ rid: newRid(), bn: 'nav-video-main', hu: 1, extra: { navUrlLen: navUrl.length, navUrlHead: navUrl.slice(0, 60) } });
          contents.downloadURL(navUrl);
        } catch (error) {
          writeTraceLog({ rid: newRid(), bn: 'nav-video-main', hu: 0, e: error instanceof Error ? error.message : String(error) });
        }
      });
    });
    await loadUserExtension();
    // 注册 IPC
    registerIPC();

    // 创建主窗口
    mainWindow = createMainWindow();

    // macOS: 点击 Dock 图标时重新创建窗口
    // 退出过程中不创建新窗口
    app.on('activate', () => {
      if (isQuitting) return;
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      }
    });
  }).catch((reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    writeCrashLog('startupFailure', error.message, error.stack);
    app.exit(1);
  });

  // 所有窗口关闭时退出应用（macOS 除外）
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // 应用退出前清理：标记退出状态，防止退出过程中创建新窗口
  app.on('before-quit', () => {
    isQuitting = true;
    unregisterIPC?.();
    mainWindow = null;
  });
}
