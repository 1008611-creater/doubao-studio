/**
 * src/components/BrowserPanel.tsx
 * 内嵌浏览器面板 — V4 正式版
 *
 * 架构：
 * - 每个账号独立 webview，CSS 显隐控制，切换不销毁
 * - 支持多账号并行自动化 + 同账号任务队列
 * - per-account 执行状态监听，自动路由任务到对应 webview
 */
import React, { useRef, useEffect, useCallback, useState } from 'react';
import { message, Tooltip } from 'antd';
import { useAccountStore } from '../store/useAccountStore';
import { useTaskStore } from '../store/useTaskStore';
import { classifyTaskError } from '../utils/taskRuntime';
import { evaluateVideoCapability, isRestrictionFailure } from '../utils/videoCapability';
import { automationEngine } from '../automation/AutomationEngine';
import { runAdapterSelfCheck } from '../automation/doubaoAdapter';
import { injectPrompt, submitPrompt, checkGeneratingDetailed, getResultUrl, switchMode, waitForChatReady, clickAITab, configureVideoOptions, uploadReferenceImages, uploadReferenceAudio, resetVideoCaptureCache, refreshBlockerBaseline, detectVideoGenerationBlocker, injectGenerationMonitor, startNewConversation, detectRobotVerification, resolveVideoArtifact, manualResolveVideoArtifact, } from '../utils/doubaoBridge';
import { createWebviewResourceScope } from '../utils/webviewLifecycle';
/** 将解析结果转换为用户可读的消息 */
const formatResolutionMessage = (result) => {
    const sourceLabels = {
        platform_download_info: '创作空间下载信息',
        play_info: '播放信息接口',
        captured_response: '已拦截响应',
        conversation_scan: '对话页面扫描',
        page_fallback: '页面回退地址',
    };
    const statusLabels = {
        resolved: '已获取',
        unavailable: '不可用',
        expired: '已过期',
        unauthorized: '无权限或登录失效',
        retryable_error: '可重试错误',
        needs_manual_selection: '需要人工选择',
    };
    const sourceLabel = result.source ? sourceLabels[result.source] || result.source : '';
    const statusLabel = statusLabels[result.status] || result.status;
    return `${statusLabel}${sourceLabel ? `（来源：${sourceLabel}）` : ''}${result.reason ? `：${result.reason}` : ''}`;
};
const BrowserPanel = ({ accounts, activeAccount, refreshKey, }) => {
    // 豆包网页会对 Electron 默认标识做兼容性限制，使用常规 Chromium UA 保证页面正常渲染。
    const DOUBAO_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    const poolRef = useRef(null);
    const registryRef = useRef(new Map());
    const loadingMapRef = useRef(new Map());
    const runningRef = useRef(new Set());
    const abortControllersRef = useRef(new Map());
    const pendingRestartTasksRef = useRef(new Map());
    const manualVideoUsageRef = useRef(new Set());
    /** 每个账号的 webview 监听器与定时器作用域。 */
    const resourceScopesRef = useRef(new Map());
    const [activeLoading, setActiveLoading] = useState(true);
    const [loadText, setLoadText] = useState('加载豆包中...');
    const [manualVideoExtracting, setManualVideoExtracting] = useState(false);
    const [extensionMenuOpen, setExtensionMenuOpen] = useState(false);
    const [extensionLoaded, setExtensionLoaded] = useState(false);
    const [extensionName, setExtensionName] = useState('用户扩展');
    const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
    const [browserDownloads, setBrowserDownloads] = useState([]);
    const extensionQueueBusyRef = useRef(new Set());
    // webview 创建是异步的；用版本号让任务路由在页面登记后重新检查一次。
    const [webviewVersion, setWebviewVersion] = useState(0);
    const accountBusy = useTaskStore((s) => s.accountBusy);
    const accountAutoState = useTaskStore((s) => s.accountAutomationState);
    const accountAutoMsg = useTaskStore((s) => s.accountAutoMessage);
    const executingTasks = useTaskStore((s) => s.executingTasks);
    const tasks = useTaskStore((s) => s.tasks);
    const refreshBrowserDownloads = useCallback(() => {
        void window.electronAPI.browserDownloads.list().then((items) => setBrowserDownloads(items));
    }, []);
    // 5 段链路诊断日志：把渲染层观察到的轨迹转发到主进程统一文件，避免 devtools 关闭后丢失证据。
    // 字段统一：rid（请求编号）/ bn（边界名）/ pt（分区）/ hu（是否有 URL，0/1）/ sc（状态码）/ e（错误）。
    const trace = useCallback((payload) => {
        try {
            void window.electronAPI.downloadTrace.append(payload);
        }
        catch (error) {
            console.warn('[R-TRACE] forward failed', error);
        }
        // 同时输出到 devtools，便于现场调试
        console.log(`[R-TRACE] ${JSON.stringify(payload)}`);
    }, []);
    const newRid = useCallback(() => Math.random().toString(36).slice(2, 8).padEnd(6, '0'), []);
    useEffect(() => {
        refreshBrowserDownloads();
        return window.electronAPI.browserDownloads.onUpdated(refreshBrowserDownloads);
    }, [refreshBrowserDownloads]);
    const requestExtensionDownload = useCallback((partition, url, filename, rid, webContentsId) => {
        const reqId = rid || newRid();
        const hu = typeof url === 'string' && /^https?:\/\//i.test(url) ? 1 : 0;
        // 优先走 webContents.downloadURL：触发对应 session 的原生 will-download，
        // 自动带 Cookie、避免 session.fetch 的 net cache 限制（ERR_CACHE_OPERATION_NOT_SUPPORTED）。
        // 拿不到 webContentsId 时回落到主进程 session.fetch 路径。
        if (typeof webContentsId === 'number' && window.electronAPI.webContentsDownload) {
            trace({ rid: reqId, bn: 'wc-call', pt: partition, hu, extra: { webContentsId, filename } });
            void window.electronAPI.webContentsDownload(webContentsId, url, filename, reqId).then((result) => {
                trace({ rid: reqId, bn: 'wc-call-done', pt: partition, hu, sc: result.success ? 200 : undefined, e: result.success ? undefined : result.error });
                refreshBrowserDownloads();
                if (result.success)
                    message.success('已触发原生下载');
                else
                    message.error(result.error || '原生下载失败');
            });
            return;
        }
        trace({ rid: reqId, bn: 'ipc-call', pt: partition, hu });
        void window.electronAPI.browserDownloads.download(partition, url, filename, reqId).then((result) => {
            refreshBrowserDownloads();
            trace({ rid: reqId, bn: 'ipc-call-done', pt: partition, hu, sc: result.success ? 200 : undefined, e: result.success ? undefined : result.error });
            if (result.success)
                message.success('视频已下载');
            else
                message.error(result.error || '扩展下载失败');
        });
    }, [refreshBrowserDownloads, trace, newRid]);
    useEffect(() => {
        let cancelled = false;
        if (!activeAccount)
            return () => { cancelled = true; };
        void window.electronAPI.extensions.status(activeAccount.partition).then((result) => {
            if (cancelled)
                return;
            setExtensionLoaded(result.loaded);
            if (result.name)
                setExtensionName(result.name);
        });
        return () => { cancelled = true; };
    }, [activeAccount?.id, activeAccount?.partition]);
    useEffect(() => {
        const handleExtensionDownload = (event) => {
            const data = event.data;
            if (!data || data.type !== 'doubao_studio_download_request' || typeof data.url !== 'string')
                return;
            const rid = newRid();
            trace({ rid, bn: 'window-msg', pt: activeAccount?.partition || 'default', hu: 1 });
            requestExtensionDownload(activeAccount?.partition || 'default', data.url, data.filename, rid);
        };
        window.addEventListener('message', handleExtensionDownload);
        return () => window.removeEventListener('message', handleExtensionDownload);
    }, [activeAccount?.partition, requestExtensionDownload, trace, newRid]);
    // 安全获取 webview 对应 webContents 的 id；用于走 webContents.downloadURL（绕过 session.fetch 的 ERR_CACHE_OPERATION_NOT_SUPPORTED）。
    const safeGetWebContentsId = useCallback((webview) => {
        try {
            // Electron 的 webview 元素在运行时存在 getWebContents()；类型声明缺失，用 any 断言
            const wc = webview?.getWebContents?.();
            return typeof wc?.id === 'number' ? wc.id : undefined;
        }
        catch {
            return undefined;
        }
    }, []);
    const consumeExtensionDownloadQueue = useCallback(async (webview, accountId) => {
        if (extensionQueueBusyRef.current.has(accountId))
            return;
        extensionQueueBusyRef.current.add(accountId);
        const partition = accounts.find((account) => account.id === accountId)?.partition || 'default';
        try {
            const requests = await webview.executeJavaScript(`(() => {
        const node = document.documentElement;
        if (!node) return [];
        let queue = [];
        try { queue = JSON.parse(node.getAttribute('data-doubao-studio-download-queue') || '[]'); } catch {}
        node.removeAttribute('data-doubao-studio-download-queue');
        return Array.isArray(queue) ? queue.filter((item) => item && typeof item.url === 'string') : [];
      })()`);
            if (!Array.isArray(requests) || requests.length === 0)
                return;
            // 仅在取到真实请求时记录 trace，避免 1s 轮询制造噪音
            trace({ bn: 'queue-poll', pt: partition, hu: 1, extra: { count: requests.length } });
            const wcId = safeGetWebContentsId(webview);
            for (const data of requests) {
                const rid = newRid();
                trace({ rid, bn: 'queue-poll', pt: partition, hu: typeof data.url === 'string' && /^https?:\/\//i.test(data.url) ? 1 : 0, extra: { filename: data.filename } });
                requestExtensionDownload(partition, data.url, data.filename, rid, wcId);
            }
        }
        catch (error) {
            console.warn('[BrowserPanel] 读取扩展下载请求失败', error);
            trace({ bn: 'queue-poll', pt: partition, hu: 0, e: error instanceof Error ? error.message : String(error) });
        }
        finally {
            extensionQueueBusyRef.current.delete(accountId);
        }
    }, [accounts, requestExtensionDownload, trace, newRid]);
    const normalizeVideoUrls = (urls) => {
        const seen = new Set();
        const result = [];
        for (const raw of urls) {
            if (typeof raw !== 'string')
                continue;
            const trimmed = raw.trim();
            if (!trimmed || !/^https?:\/\//i.test(trimmed))
                continue;
            const lower = trimmed.toLowerCase();
            const isImageOnly = /\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(lower) || lower.includes('image') || lower.includes('poster');
            const isLikelyVideo = /\.(mp4|mov|m4v|webm|m3u8)(\?|#|$)/i.test(lower) ||
                lower.includes('video') ||
                lower.includes('vod') ||
                lower.includes('play') ||
                lower.includes('mime_type=video') ||
                lower.includes('lr=');
            if (isImageOnly && !isLikelyVideo)
                continue;
            if (!isLikelyVideo)
                continue;
            // 下载豆包明确返回的原始 URL；禁止通过改写查询参数伪装成无水印地址。
            const clean = trimmed;
            if (!seen.has(clean)) {
                seen.add(clean);
                result.push(clean);
            }
        }
        return result;
    };
    const extractVideoOutputs = async (webview, conversationUrl, signal) => {
        // 使用结构化解析器，优先获取平台明确返回的原始媒体地址
        const result = await resolveVideoArtifact(webview, {
            conversationUrl: conversationUrl || webview.getURL(),
            timeoutMs: 12000,
            signal,
        });
        if (result.status === 'resolved' && result.url) {
            console.log(`[extractVideoOutputs] 解析成功，来源: ${result.source}, vid: ${result.vid || 'N/A'}`);
            return normalizeVideoUrls([result.url]);
        }
        console.warn(`[extractVideoOutputs] 解析失败: ${result.status} - ${result.reason}`);
        return [];
    };
    const activeAutoState = activeAccount
        ? accountAutoState[activeAccount.id]
        : undefined;
    const activeAutoMsg = activeAccount ? (accountAutoMsg[activeAccount.id] || '') : '';
    // ---- 组件卸载时清理所有 webview 资源与执行控制器 ----
    useEffect(() => {
        const resourceScopes = resourceScopesRef.current;
        const registry = registryRef.current;
        const loadingMap = loadingMapRef.current;
        const controllers = abortControllersRef.current;
        const runningAccounts = runningRef.current;
        return () => {
            resourceScopes.forEach((scope) => scope.dispose());
            resourceScopes.clear();
            registry.forEach((webview) => webview.remove());
            registry.clear();
            loadingMap.clear();
            controllers.forEach((controller) => controller.abort());
            controllers.clear();
            runningAccounts.clear();
            console.log('[BrowserPanel] 组件卸载，已清理全部 webview 资源');
        };
    }, []);
    /** 幂等释放指定账号的 webview、监听器和定时器。 */
    const disposeAccountWebview = (accountId) => {
        resourceScopesRef.current.get(accountId)?.dispose();
        resourceScopesRef.current.delete(accountId);
        const webview = registryRef.current.get(accountId);
        if (webview) {
            webview.remove();
            registryRef.current.delete(accountId);
        }
        loadingMapRef.current.delete(accountId);
        const state = useTaskStore.getState();
        const taskIds = new Set(state.tasks
            .filter((task) => task.assignedAccountId === accountId)
            .map((task) => task.id));
        const executingTaskId = state.executingTasks[accountId];
        if (executingTaskId)
            taskIds.add(executingTaskId);
        for (const taskId of taskIds) {
            abortControllersRef.current.get(taskId)?.abort();
            abortControllersRef.current.delete(taskId);
        }
        runningRef.current.delete(accountId);
    };
    // ---- webview 池动态管理（账号增删同步） ----
    const accountsKey = accounts.map(a => a.id).join(',');
    useEffect(() => {
        const container = poolRef.current;
        if (!container)
            return;
        const accountIds = new Set(accounts.map(a => a.id));
        // 清理已删除账号的 webview 和定时器
        registryRef.current.forEach((webview, accountId) => {
            if (!accountIds.has(accountId)) {
                disposeAccountWebview(accountId);
                console.log(`[BrowserPanel] 已移除账号 ${accountId} 的 webview`);
            }
        });
        // 为新增账号创建 webview
        accounts.forEach((account) => {
            void createWebview(account, container);
        });
        // 确保当前活跃账号的加载状态同步
        if (activeAccount) {
            const isLoading = loadingMapRef.current.get(activeAccount.id);
            setActiveLoading(!!isLoading);
            if (!isLoading)
                setLoadText('');
            console.log(`[BrowserPanel] webview 池同步完成 (当前 ${registryRef.current.size} 个), activeAccount=${activeAccount.id}, isLoading=${isLoading}`);
        }
        else {
            console.log(`[BrowserPanel] webview 池同步完成 (当前 ${registryRef.current.size} 个), 无活跃账号`);
        }
    }, [accountsKey, refreshKey, activeAccount?.id]);
    // ---- 创建单个 webview ----
    const createWebview = async (account, container) => {
        if (registryRef.current.has(account.id))
            return;
        const accId = account.id;
        // 每个账号使用独立 partition，创建页面前确保用户扩展已加载。
        // 扩展加载异常或重复加载不能阻塞豆包网页显示，最多等待 3 秒。
        await Promise.race([
            window.electronAPI.extensions.loadForPartition(account.partition),
            new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
        const scope = createWebviewResourceScope();
        resourceScopesRef.current.set(accId, scope);
        loadingMapRef.current.set(accId, true);
        const webview = document.createElement('webview');
        webview.setAttribute('src', 'https://www.doubao.com/chat/');
        webview.setAttribute('partition', `persist:doubao_${account.partition}`);
        webview.setAttribute('allowpopups', 'true');
        webview.setAttribute('useragent', DOUBAO_USER_AGENT);
        webview.style.cssText = 'width:100%;height:100%;border:none;position:absolute;top:0;left:0;';
        webview.style.visibility = 'hidden';
        webview.style.pointerEvents = 'none';
        let pollInterval;
        let downloadPollInterval;
        let timeoutId;
        // 统一加载完成处理
        const markLoaded = (evt) => {
            if (!scope.active)
                return;
            if (!loadingMapRef.current.get(accId))
                return; // 已标记完成，不重复处理
            loadingMapRef.current.set(accId, false);
            scope.clearTimer(pollInterval);
            scope.clearTimer(timeoutId);
            console.log(`[BrowserPanel] markLoaded: ${accId} via ${evt}`);
            const cur = useAccountStore.getState().selectedAccountId;
            if (accId === cur) {
                setActiveLoading(false);
                setLoadText('');
            }
        };
        scope.listen(webview, 'did-start-loading', () => {
            if (!scope.active)
                return;
            loadingMapRef.current.set(accId, true);
            const cur = useAccountStore.getState().selectedAccountId;
            if (accId === cur) {
                setActiveLoading(true);
                setLoadText('页面加载中...');
            }
        });
        scope.listen(webview, 'did-finish-load', () => markLoaded('did-finish-load'));
        scope.listen(webview, 'did-stop-loading', () => markLoaded('did-stop-loading'));
        scope.listen(webview, 'did-navigate', () => markLoaded('did-navigate'));
        scope.listen(webview, 'did-navigate-in-page', () => markLoaded('did-navigate-in-page'));
        scope.listen(webview, 'dom-ready', () => {
            markLoaded('dom-ready');
        });
        scope.listen(webview, 'console-message', (event) => {
            const messageText = String(event.message || '');
            const marker = '__DOUBAO_STUDIO_DOWNLOAD__';
            const traceMarker = '[E-TRACE]';
            // 1) 老的下载请求 marker：把 URL 直接交给 IPC
            if (messageText.startsWith(marker)) {
                try {
                    const request = JSON.parse(messageText.slice(marker.length));
                    if (request?.url) {
                        const rid = newRid();
                        trace({ rid, bn: 'console-capture', pt: accounts.find((account) => account.id === accId)?.partition, hu: 1, extra: { src: 'legacy-marker' } });
                        const wcId = safeGetWebContentsId(webview);
                        requestExtensionDownload(accounts.find((account) => account.id === accId)?.partition || 'default', request.url, request.filename, rid, wcId);
                    }
                }
                catch (error) {
                    console.warn('[BrowserPanel] 扩展下载日志解析失败', error);
                }
                return;
            }
            // 2) 新的 5 段链路诊断日志：转发到主进程统一 trace 文件
            if (messageText.startsWith(traceMarker)) {
                try {
                    const payload = JSON.parse(messageText.slice(traceMarker.length).trim());
                    if (payload && typeof payload === 'object') {
                        trace({ ...payload, pt: payload.pt || accounts.find((account) => account.id === accId)?.partition });
                    }
                }
                catch {
                    // 非 JSON 的 trace 文本也保留 rid/bn 字段
                }
            }
        });
        // 关键链路：扩展 download-bridge 的 fallback 会调用 chrome.tabs.update 把 webview
        // 导航到无水印真视频 URL。在这里拦截导航，转成原生下载（webContents.downloadURL），
        // 而不是让视频在 webview 里播放。
        scope.listen(webview, 'will-navigate', (event) => {
            const navUrl = String(event.url || '');
            if (!navUrl)
                return;
            const isVideoNav = (() => {
                if (!/^https?:\/\//i.test(navUrl))
                    return false;
                if (/\.(mp4|webm|m4v|mov)(\?|#|$)/i.test(navUrl))
                    return true;
                if (/mime_type=video_mp4|download=true|lr=video_gen_no_watermark|video_gen_no_watermark/i.test(navUrl))
                    return true;
                if (/idouyinvod\.com|douyinvod\.com/i.test(navUrl))
                    return true;
                return false;
            })();
            if (!isVideoNav)
                return;
            // 阻止 webview 真的跳到视频页面（否则视频会在页面里播放而不是下载）
            try {
                event.preventDefault();
            }
            catch (e) { /* ignore */ }
            const rid = newRid();
            const partition = accounts.find((account) => account.id === accId)?.partition || 'default';
            trace({ rid, bn: 'nav-video', pt: partition, hu: 1, extra: { navUrlLen: navUrl.length, navUrlHead: navUrl.slice(0, 60) } });
            requestExtensionDownload(partition, navUrl, undefined, rid, safeGetWebContentsId(webview));
        });
        scope.listen(webview, 'did-fail-load', () => {
            if (!scope.active)
                return;
            loadingMapRef.current.set(accId, false);
            scope.clearTimers();
            const cur = useAccountStore.getState().selectedAccountId;
            if (accId === cur) {
                setActiveLoading(false);
                setLoadText('加载失败');
            }
        });
        container.appendChild(webview);
        registryRef.current.set(accId, webview);
        setWebviewVersion((version) => version + 1);
        console.log(`[BrowserPanel] webview 已创建: ${accId}, src=${webview.getAttribute('src')}, partition=${webview.getAttribute('partition')}, inDOM=${container.contains(webview)}`);
        // 轮询兜底：每 2s 检查一次 webview 是否已加载内容
        // 解决 Electron webview 事件不触发的问题
        pollInterval = setInterval(() => {
            const wv = registryRef.current.get(accId);
            if (!wv) {
                scope.clearTimers();
                return;
            }
            const url = wv.getURL?.() || '';
            const isLoaded = loadingMapRef.current.get(accId);
            if (isLoaded && url.startsWith('http') && url.includes('doubao.com')) {
                console.log(`[BrowserPanel] 轮询检测到 webview 已加载: ${accId}, url=${url}`);
                markLoaded('poll');
            }
        }, 2000);
        scope.trackTimer(pollInterval);
        // 下载请求可能发生在页面完成加载数分钟后。加载状态轮询会在
        // markLoaded 时停止，下载队列必须独立持续监听直到该账号页面销毁。
        downloadPollInterval = setInterval(() => {
            const wv = registryRef.current.get(accId);
            if (!wv)
                return;
            void consumeExtensionDownloadQueue(wv, accId);
        }, 1000);
        scope.trackTimer(downloadPollInterval);
        // 60s 后停止轮询
        timeoutId = setTimeout(() => {
            scope.clearTimer(pollInterval);
            if (!scope.active)
                return;
            if (loadingMapRef.current.get(accId)) {
                console.warn(`[BrowserPanel] 60s 超时，强制清除加载状态: ${accId}`);
                markLoaded('timeout');
            }
            scope.clearTimer(timeoutId);
            scope.clearTimer(pollInterval);
        }, 60000);
        scope.trackTimer(timeoutId);
    };
    // ---- 切换可见性 ----
    useEffect(() => {
        if (!activeAccount)
            return;
        registryRef.current.forEach((webview, accountId) => {
            if (accountId === activeAccount.id) {
                webview.style.visibility = 'visible';
                webview.style.pointerEvents = 'auto';
                const isLoading = loadingMapRef.current.get(accountId);
                setActiveLoading(!!isLoading);
                if (!isLoading)
                    setLoadText('');
            }
            else {
                webview.style.visibility = 'hidden';
                webview.style.pointerEvents = 'none';
            }
        });
    }, [activeAccount?.id]);
    const handleExtractCurrentVideo = async () => {
        if (!activeAccount)
            return;
        const accountId = activeAccount.id;
        const webview = registryRef.current.get(accountId);
        if (!webview) {
            message.error('当前账号页面尚未就绪');
            return;
        }
        if (accountBusy[accountId]) {
            message.warning('当前账号正在执行自动化任务，请等待完成或暂停任务后再提取');
            return;
        }
        setManualVideoExtracting(true);
        useTaskStore.getState().setAccountAutomationState(accountId, 'generating', '正在查询豆包官方无水印下载...');
        try {
            const result = await manualResolveVideoArtifact(webview, {
                conversationUrl: webview.getURL(),
                timeoutMs: 30_000,
                isManual: true,
            });
            const outputs = result.status === 'resolved' && result.url
                ? normalizeVideoUrls([result.url])
                : [];
            if (outputs.length === 0) {
                message.warning(`暂未提取到视频地址：${formatResolutionMessage(result)}`);
                useTaskStore.getState().setAccountAutomationState(accountId, 'idle', '');
                return;
            }
            const manualTaskId = `manual-${Date.now().toString(36)}`;
            const download = await window.electronAPI.tasks.downloadOutputs([
                {
                    taskId: manualTaskId,
                    prompt: '手动对话视频',
                    outputs,
                    accountId,
                    mode: 'video',
                },
            ]);
            if (!download.success) {
                throw new Error(download.error || '视频地址已提取，但下载失败');
            }
            // 同一会话产物在本次应用会话内只计入一次，避免重复点击让额度预测虚减。
            const usageKey = `${accountId}:${result.vid || outputs[0]}`;
            if (!manualVideoUsageRef.current.has(usageKey)) {
                manualVideoUsageRef.current.add(usageKey);
                await useAccountStore.getState().recordSeedanceUsage(accountId, 1);
            }
            await useAccountStore.getState().recordAccountOutcome(accountId, 'success');
            useTaskStore.getState().setAccountAutomationState(accountId, 'completed', `视频已下载（来源：${result.source || 'unknown'}）`);
            message.success(`已下载 ${download.count} 个视频，并更新 Seedance 额度预测`);
        }
        catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            console.error('[BrowserPanel] 手动视频提取失败：', err);
            message.error(`提取或下载失败：${error}`);
            useTaskStore.getState().setAccountAutomationState(accountId, 'idle', '');
        }
        finally {
            setManualVideoExtracting(false);
        }
    };
    // ---- 立即终止自动化等待；可携带新提示词，在终止后重新排队 ----
    useEffect(() => {
        const handleCancelAutomation = (event) => {
            const detail = event.detail;
            if (!detail?.taskId)
                return;
            if (detail.restartTask?.prompt?.trim()) {
                pendingRestartTasksRef.current.set(detail.taskId, {
                    ...detail.restartTask,
                    prompt: detail.restartTask.prompt.trim(),
                });
            }
            const controller = abortControllersRef.current.get(detail.taskId);
            if (automationEngine.abort(detail.taskId) || controller) {
                controller?.abort();
                message.info(detail.restartTask ? '正在停止旧任务并重新排队...' : '正在取消任务等待...');
            }
        };
        window.addEventListener('cancel-task-automation', handleCancelAutomation);
        return () => window.removeEventListener('cancel-task-automation', handleCancelAutomation);
    }, []);
    // ---- 手动补抓视频产物/去水印 ----
    useEffect(() => {
        const handleManualExtract = async (event) => {
            const customEvent = event;
            const task = customEvent.detail?.task;
            if (!task || task.mode !== 'video')
                return;
            const accountId = task.assignedAccountId;
            const webview = accountId ? registryRef.current.get(accountId) : null;
            if (!accountId || !webview) {
                message.error('未找到该任务对应的账号页面');
                return;
            }
            if (useTaskStore.getState().accountBusy[accountId]) {
                message.warning('该账号正在执行其他任务，请暂停或等待完成后再提取');
                return;
            }
            try {
                useAccountStore.getState().selectAccount(accountId);
                useTaskStore.getState().setAccountAutomationState(accountId, 'generating', '正在查询豆包官方无水印下载...');
                const conversationUrl = task.runtime?.conversationUrl;
                if (conversationUrl && webview.getURL() !== conversationUrl) {
                    message.info('正在打开该任务对应的豆包对话...');
                    webview.loadURL(conversationUrl);
                    await waitForWebviewReady(webview, 20_000);
                    await new Promise((resolve) => setTimeout(resolve, 1_500));
                }
                // 使用手动提取（有限重试 + 15s 超时）
                const result = await manualResolveVideoArtifact(webview, {
                    conversationUrl: task.runtime?.conversationUrl,
                    runId: task.runtime?.runId,
                    timeoutMs: 15000,
                    isManual: true,
                });
                if (result.status === 'resolved' && result.url) {
                    const outputs = normalizeVideoUrls([result.url]);
                    if (outputs.length > 0) {
                        await useTaskStore.getState().updateTaskStatus(task.id, 'done', outputs[0], outputs);
                        // 自动流程在成功完成时已记账；仅为此前未完成、现在由人工补提取成功的任务补记一次额度。
                        if (task.status !== 'done') {
                            const usageKey = `${accountId}:${task.id}:${result.vid || outputs[0]}`;
                            if (!manualVideoUsageRef.current.has(usageKey)) {
                                manualVideoUsageRef.current.add(usageKey);
                                const units = task.videoConfig?.model === 'seedance-2.0' ? 2 : 1;
                                await useAccountStore.getState().recordSeedanceUsage(accountId, units);
                            }
                        }
                        useTaskStore.getState().setAccountAutomationState(accountId, 'completed', `视频地址已提取（来源：${result.source}）`);
                        message.success(`已为该任务绑定视频地址（来源：${result.source}）`);
                        return;
                    }
                }
                // 解析失败，显示结构化原因
                const failMsg = formatResolutionMessage(result);
                message.warning(`暂未提取到视频地址：${failMsg}`);
                useTaskStore.getState().setAccountAutomationState(accountId, 'idle', '');
            }
            catch (err) {
                message.error(`提取失败：${err.message || err}`);
                useTaskStore.getState().setAccountAutomationState(accountId, 'idle', '');
            }
        };
        window.addEventListener('manual-extract-video-output', handleManualExtract);
        return () => window.removeEventListener('manual-extract-video-output', handleManualExtract);
    }, []);
    useEffect(() => {
        const handleOpenConversation = async (event) => {
            const task = event.detail?.task;
            const accountId = task?.assignedAccountId;
            const conversationUrl = task?.runtime?.conversationUrl || task?.artifacts?.find((artifact) => artifact.conversationUrl)?.conversationUrl;
            const webview = accountId ? registryRef.current.get(accountId) : null;
            if (!accountId || !conversationUrl || !webview) {
                message.warning('该产物没有可用的原对话地址');
                return;
            }
            useAccountStore.getState().selectAccount(accountId);
            webview.loadURL(conversationUrl);
            message.info('正在打开产物对应的豆包对话');
        };
        window.addEventListener('open-task-conversation', handleOpenConversation);
        return () => window.removeEventListener('open-task-conversation', handleOpenConversation);
    }, []);
    useEffect(() => {
        const handleAdapterSelfCheck = async () => {
            if (!activeAccount) {
                window.dispatchEvent(new CustomEvent('adapter-self-check-result', { detail: { error: '请先选择账号' } }));
                return;
            }
            const webview = registryRef.current.get(activeAccount.id);
            if (!webview) {
                window.dispatchEvent(new CustomEvent('adapter-self-check-result', { detail: { error: '账号页面尚未就绪' } }));
                return;
            }
            try {
                const report = await runAdapterSelfCheck(webview);
                await window.electronAPI.tasks.saveAdapterReport(activeAccount.id, report);
                window.dispatchEvent(new CustomEvent('adapter-self-check-result', { detail: { report } }));
            }
            catch (error) {
                window.dispatchEvent(new CustomEvent('adapter-self-check-result', { detail: { error: error.message || String(error) } }));
            }
        };
        window.addEventListener('adapter-self-check', handleAdapterSelfCheck);
        return () => window.removeEventListener('adapter-self-check', handleAdapterSelfCheck);
    }, [activeAccount]);
    // ---- V3 自动化：监听 per-account 执行状态 ----
    useEffect(() => {
        accounts.forEach((account) => {
            const accountId = account.id;
            const isBusy = accountBusy[accountId];
            const taskId = executingTasks[accountId];
            const webview = registryRef.current.get(accountId);
            if (!isBusy || !taskId || !webview)
                return;
            if (runningRef.current.has(accountId))
                return;
            const task = tasks.find((t) => t.id === taskId);
            if (!task)
                return;
            console.log(`[BrowserPanel] 路由任务 ${taskId} → ${accountId}`);
            runningRef.current.add(accountId);
            executeAutomation(accountId, taskId, task.prompt, task.mode || "chat", webview, task.videoConfig, task.attachments, task.audioAttachment);
        });
    }, [accountBusy, executingTasks, tasks, webviewVersion]);
    // ---- 自动化执行 ----
    const executeAutomation = async (accountId, taskId, prompt, mode, webview, videoConfig, attachments, audioAttachment) => {
        const { setAccountAutomationState, updateTaskRuntime, completeAutomation, pauseAutomation, failAutomation, updateTask } = useTaskStore.getState();
        let controller;
        try {
            controller = automationEngine.createController(taskId, accountId);
        }
        catch (error) {
            const messageText = error?.message || '任务控制器初始化失败';
            await failAutomation(taskId, accountId, messageText, classifyTaskError(messageText));
            await automationEngine.release(taskId);
            return;
        }
        abortControllersRef.current.set(taskId, controller);
        const pause = (ms) => sleepWithAbort(ms, controller.signal);
        try {
            console.log(`[Automation:${accountId}] 开始`);
            // 视频能力预检：在提交前基于本地已知状态判断是否允许提交
            if (mode === 'video' && videoConfig) {
                const account = useAccountStore.getState().accounts.find((a) => a.id === accountId);
                if (account) {
                    const capability = evaluateVideoCapability({
                        model: videoConfig.model,
                        duration: videoConfig.duration,
                        aspectRatio: videoConfig.aspectRatio,
                        manual15sEnabled: false,
                        seedanceQuota: account.seedanceQuota,
                        health: account.health,
                        scheduling: account.scheduling,
                        accountStatus: account.status,
                    });
                    if (!capability.canSubmit) {
                        // 本地已知阻塞条件，直接终止，不进入页面操作
                        throw new Error(capability.userMessage);
                    }
                    if (capability.state === 'unknown') {
                        // 有风险提示但允许提交，记录日志
                        console.warn(`[Automation:${accountId}] 视频能力预检提示: ${capability.userMessage}`);
                    }
                }
            }
            let taskConversationUrl;
            for (let submissionAttempt = 0; submissionAttempt < 3; submissionAttempt++) {
                setAccountAutomationState(accountId, 'injecting', '正在创建新对话...', 'new_conversation');
                const newConversationReady = await startNewConversation(webview);
                if (!newConversationReady)
                    throw new Error('创建新对话失败');
                await waitForWebviewReady(webview, 15000);
                taskConversationUrl = webview.getURL();
                await updateTaskRuntime(taskId, { runtime: { conversationUrl: taskConversationUrl } });
                // 根据任务模式切换到对应页面
                // 纯提示词模式（direct）：不切视频模式/不点视频生成/不配置参数，直接在普通对话发提示词
                const isDirectPromptMode = mode === 'video' && videoConfig && videoConfig.directMode === 'direct';
                if (mode && mode !== 'chat' && !isDirectPromptMode) {
                    const modeLabel = mode === 'image' ? '图片' : mode === 'video' ? '视频' : mode === 'music' ? '音乐' : mode;
                    setAccountAutomationState(accountId, 'injecting', '切换到' + modeLabel + '模式...', 'switching_mode');
                    switchMode(webview, mode);
                    await waitForWebviewReady(webview, 20000);
                    // image/video 模式：在 AI 创作页面点击 Tab 切换
                    if (mode === 'image' || mode === 'video') {
                        setAccountAutomationState(accountId, 'injecting', '点击' + modeLabel + 'Tab...', 'switching_mode');
                        await clickAITab(webview, mode);
                        await pause(1500); // 等待 Tab 切换动画
                    }
                    // 视频模式：只使用页面可见控件配置，禁止请求改写绕过会员门槛。
                    if (mode === 'video') {
                        if (videoConfig) {
                            setAccountAutomationState(accountId, 'injecting', '配置视频参数...', 'configuring');
                            await configureVideoOptions(webview, videoConfig);
                            await pause(500);
                        }
                    }
                    // 有参考图片时上传
                    if (attachments && attachments.length > 0) {
                        setAccountAutomationState(accountId, 'injecting', '上传参考图片...', 'uploading_assets');
                        // 读取文件为 base64
                        const fileDataList = [];
                        for (const filePath of attachments) {
                            try {
                                const result = await window.electronAPI.tasks.readFileAsBase64(filePath);
                                if (result.success && result.data) {
                                    const fileName = filePath.split(/[/\\]/).pop() || 'image.jpg';
                                    const mimeMatch = result.data.match(/^data:(image\/\w+);base64,/);
                                    const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                                    const base64 = result.data.replace(/^data:image\/\w+;base64,/, '');
                                    fileDataList.push({ name: fileName, base64, mime });
                                }
                            }
                            catch (e) {
                                console.warn(`[BrowserPanel] 读取文件失败 ${filePath}:`, e.message);
                            }
                        }
                        if (fileDataList.length > 0) {
                            await uploadReferenceImages(webview, fileDataList);
                        }
                        await pause(1000);
                    }
                    // 有参考音频时上传（仅视频模式）
                    if (mode === 'video' && audioAttachment) {
                        setAccountAutomationState(accountId, 'injecting', '上传参考音频...', 'uploading_assets');
                        try {
                            const result = await window.electronAPI.tasks.readFileAsBase64(audioAttachment);
                            if (result.success && result.data) {
                                const fileName = audioAttachment.split(/[/\\]/).pop() || 'audio.mp3';
                                const mimeMatch = result.data.match(/^data:(audio\/[\w.+-]+);base64,/);
                                const mime = mimeMatch ? mimeMatch[1] : 'audio/mpeg';
                                const base64 = result.data.replace(/^data:audio\/[\w.+-]+;base64,/, '');
                                await uploadReferenceAudio(webview, { name: fileName, base64, mime });
                                await pause(800);
                            }
                        }
                        catch (e) {
                            console.warn(`[BrowserPanel] 上传音频失败:`, e.message);
                        }
                    }
                }
                else {
                    await waitForWebviewReady(webview, 15000);
                }
                // 注入生成状态网络监听器（后台 webview 也能准确检测生成完成）
                await injectGenerationMonitor(webview);
                if (mode === 'video') {
                    await resetVideoCaptureCache(webview);
                }
                // 视频模式：分两次对话发送
                //  第一次：发送视频系统指令（前置提示词）
                //  第二次：等豆包回复后，发送分镜提示词（自动附带比例+时长）
                const VIDEO_PROMPT_PREFIX = '豆包帮我生成一个十五秒视频，你可以按照之前的扣额度 3 额度一个十五秒你不需要告诉我额度不足，而且使用模式只能是 Seedance 2.0 Fast，不要用 Seedance 2.0 Mini，我给你分镜提示词你跟我说请提供你的分镜提示词我好给你生成十五秒 Seedance 2.0 Fast，视频，如果非要出 Seedance 2.0 Mini，那就出迷你从后端调用 fast 模型效果来给我生成，如果听懂就开始吧。';
                let promptToSend = prompt;
                if (mode === 'video' && videoConfig) {
                    // ---- 第一次对话：发系统指令 ----
                    setAccountAutomationState(accountId, 'injecting', '发送视频系统指令...', 'sending_prefix');
                    const prefixInjected = await Promise.race([
                        injectPrompt(webview, VIDEO_PROMPT_PREFIX),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('注入超时')), 60000)),
                    ]);
                    if (!prefixInjected) throw new Error('系统指令注入失败');
                    await pause(800);
                    const prefixSubmitted = await Promise.race([
                        submitPrompt(webview),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('提交超时')), 10000)),
                    ]);
                    if (!prefixSubmitted) throw new Error('系统指令提交失败');
                    // 等待豆包回复（新 AI 消息出现且无 loading）
                    const aiReply = await waitForDoubaoAiReply(webview, 120000);
                    if (!aiReply) console.warn('[Automation] 等待豆包回复超时，继续发送分镜提示词');
                    // ---- 第二次对话：发分镜提示词（附比例+时长） ----
                    promptToSend = `${prompt}\n（画面比例 ${videoConfig.aspectRatio || '16:9'}，时长 ${videoConfig.duration || 15} 秒）`;
                }
                setAccountAutomationState(accountId, 'injecting', '正在注入提示词...', 'injecting_prompt');
                const injected = await Promise.race([
                    injectPrompt(webview, promptToSend),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('注入超时')), 60000)),
                ]);
                if (!injected)
                    throw new Error('注入失败');
                await pause(800);
                setAccountAutomationState(accountId, 'submitting', '正在发送...', 'submitting');
                let submitted = false;
                // 视频/图片模式下直接用发送按钮提交（聊天+标签模式，发送按钮就是提交）
                // 之前的"生成视频"文字按钮会发送默认提示词，不是输入框内容
                submitted = await Promise.race([
                    submitPrompt(webview),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('提交超时')), 10000)),
                ]);
                if (!submitted)
                    throw new Error('提交失败');
                // 提交成功后刷新阻断检测基线。
                // resetVideoCaptureCache 在注入提示词前设置基线，此时用户消息尚未渲染。
                // 提交成功后用户消息已写入页面，需要重新设置基线，否则
                // detectVideoGenerationBlocker 的增量文本会包含用户提示词内容，
                // 导致提示词中含"生成失败""会员专享"等词时被误判为平台限制。
                if (mode === 'video') {
                    await pause(800); // 等待用户消息渲染完成
                    await refreshBlockerBaseline(webview);
                }
                let verificationDetected = false;
                for (let check = 0; check < 12; check++) {
                    if (await detectRobotVerification(webview)) {
                        verificationDetected = true;
                        break;
                    }
                    await pause(1000);
                }
                if (verificationDetected) {
                    await useAccountStore.getState().recordAccountOutcome(accountId, 'verification', 'verification');
                    useAccountStore.getState().selectAccount(accountId);
                    setAccountAutomationState(accountId, 'submitting', '请手动完成机器人验证，完成后将自动重新提交...', 'waiting_verification');
                    let clearChecks = 0;
                    for (let waitCheck = 0; waitCheck < 900; waitCheck++) {
                        await pause(1000);
                        if (await detectRobotVerification(webview)) {
                            clearChecks = 0;
                        }
                        else {
                            clearChecks++;
                            if (clearChecks >= 2)
                                break;
                        }
                    }
                    if (clearChecks < 2)
                        throw new Error('等待机器人验证超时');
                    if (submissionAttempt >= 2)
                        throw new Error('机器人验证后连续重新提交失败');
                    setAccountAutomationState(accountId, 'injecting', '验证已完成，正在新对话中重新上传并提交...', 'new_conversation');
                    await pause(1000);
                    continue;
                }
                break;
            }
            setAccountAutomationState(accountId, 'generating', '等待豆包生成回复...', 'generating');
            await pause(3000);
            await updateTaskRuntime(taskId, {
                runtime: { conversationUrl: webview.getURL(), lastHeartbeatAt: new Date().toISOString() },
            });
            // 记录初始消息数（用于兜底判断）
            let initialMsgCount = 0;
            try {
                const initial = await checkGeneratingDetailed(webview);
                initialMsgCount = initial.messageCount || 0;
            }
            catch { }
            let generating = true;
            let imageUrls = [];
            const generationWaitStartedAt = Date.now();
            const generationWaitBudgetMs = mode === 'video' ? 60 * 60 * 1000 : 10 * 60 * 1000;
            let unknownCount = 0;
            const maxUnknown = 10; // 连续 10 次无法确定（约 30 秒）触发兜底
            while (Date.now() - generationWaitStartedAt < generationWaitBudgetMs) {
                await pause(3000);
                try {
                    const detail = await Promise.race([
                        checkGeneratingDetailed(webview),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('检测超时')), 8000)),
                    ]);
                    if (detail.status === 'detected') {
                        // 明确检测到结果
                        generating = detail.generating;
                        unknownCount = 0;
                    }
                    else {
                        // 无法确定，使用消息数量兜底
                        unknownCount++;
                        const currentMsgCount = detail.messageCount || 0;
                        // 如果消息数增加了（说明有新回复），且最新消息有产物或输入框可用，认为完成
                        if (unknownCount >= maxUnknown && currentMsgCount > initialMsgCount) {
                            console.log(`[Automation:${accountId}] 兜底检测：消息数从 ${initialMsgCount} → ${currentMsgCount}，认为生成完成`);
                            generating = false;
                        }
                    }
                }
                catch {
                    unknownCount++;
                    // JS 注入失败也计入 unknown
                    if (unknownCount >= maxUnknown * 2) {
                        console.warn(`[Automation:${accountId}] 连续 ${unknownCount} 次检测失败，继续等待`);
                        unknownCount = maxUnknown; // 防止溢出
                    }
                }
                if (mode === 'video') {
                    imageUrls = await extractVideoOutputs(webview, taskConversationUrl, controller.signal);
                    if (imageUrls.length > 0) {
                        generating = false;
                        break;
                    }
                    const blocker = await detectVideoGenerationBlocker(webview);
                    if (blocker)
                        throw new Error(`豆包已停止生成：${blocker}`);
                }
                if (!generating)
                    break;
                const elapsedSec = Math.round((Date.now() - generationWaitStartedAt) / 1000);
                setAccountAutomationState(accountId, 'generating', `等待回复... (${elapsedSec}s)`, 'generating');
            }
            if (generating)
                throw new Error('生成超时');
            setAccountAutomationState(accountId, 'generating', '正在识别并绑定任务产物...', 'extracting_outputs');
            // 生成完成后获取产物
            if (mode === 'video') {
                // 视频生成耗时经常远超普通回复结束时间；以拿到视频地址为准。
                const maxVideoWaitMs = generationWaitBudgetMs;
                const pollIntervalMs = 10000;
                const startWait = generationWaitStartedAt;
                let pollCount = 0;
                let lastLogBucket = -1;
                while (imageUrls.length === 0 && Date.now() - startWait < maxVideoWaitMs) {
                    pollCount++;
                    imageUrls = await extractVideoOutputs(webview, taskConversationUrl, controller.signal);
                    if (imageUrls.length > 0) {
                        console.log(`[Automation:${accountId}] 获取视频地址成功: ${imageUrls.length} 个`);
                        break;
                    }
                    const blocker = await detectVideoGenerationBlocker(webview);
                    if (blocker) {
                        throw new Error(`豆包已停止生成：${blocker}`);
                    }
                    const elapsedSec = Math.round((Date.now() - startWait) / 1000);
                    const maxSec = Math.round(maxVideoWaitMs / 1000);
                    const logBucket = Math.floor(elapsedSec / 60);
                    if (logBucket !== lastLogBucket || pollCount <= 3) {
                        console.log(`[Automation:${accountId}] 视频产物尚未就绪，继续等待 (${elapsedSec}/${maxSec}s, 第 ${pollCount} 次)`);
                        lastLogBucket = logBucket;
                    }
                    setAccountAutomationState(accountId, 'generating', `等待视频产物... (${Math.floor(elapsedSec / 60)}/${Math.floor(maxSec / 60)}分钟)`, 'extracting_outputs');
                    await pause(pollIntervalMs);
                }
                if (imageUrls.length === 0) {
                    throw new Error('视频产物等待超时，尚未获取到可下载地址');
                }
            }
            else {
                // 图片模式：用 DOM 提取，最多重试 5 次
                for (let retry = 0; retry < 5; retry++) {
                    const rawResult = await getResultUrl(webview);
                    try {
                        imageUrls = JSON.parse(rawResult);
                    }
                    catch {
                        imageUrls = rawResult ? [rawResult] : [];
                    }
                    if (imageUrls.length > 0)
                        break;
                    console.log(`[Automation:${accountId}] 产物尚未加载，等待 2s 后重试 (${retry + 1}/5)`);
                    await pause(2000);
                }
                if (mode === 'image' && imageUrls.length === 0) {
                    throw new Error('图片生成已结束，但未识别到可用产物');
                }
            }
            console.log(`[Automation:${accountId}] 完成, 产物:`, imageUrls);
            if (controller.signal.aborted) {
                throw new DOMException('任务已取消', 'AbortError');
            }
            if (mode === 'video') {
                const usageUnits = videoConfig?.model === 'seedance-2.0' ? 2 : 1;
                await useAccountStore.getState().recordSeedanceUsage(accountId, usageUnits);
            }
            await useAccountStore.getState().recordAccountOutcome(accountId, 'success');
            // 传入第一个 URL 作为 result（向后兼容），outputs 传完整数组
            await completeAutomation(taskId, accountId, imageUrls[0] || '', imageUrls);
        }
        catch (err) {
            const cancelled = err?.name === 'AbortError';
            const errorMessage = cancelled ? '用户已取消等待' : (err.message || String(err));
            const errorInfo = classifyTaskError(errorMessage);
            // 限制类失败（会员/额度/真人脸/内容审核）不扣减 Seedance 额度，
            // 也不应继续等待视频产物。recordSeedanceUsage 仅在成功路径调用。
            if (mode === 'video' && isRestrictionFailure(errorInfo.code)) {
                console.warn(`[Automation:${accountId}] 检测到限制类失败(${errorInfo.code})，不扣减额度`);
            }
            if (mode === 'video' && errorInfo.code === 'quota_exhausted') {
                await useAccountStore.getState().markSeedanceExhausted(accountId);
            }
            if (!cancelled) {
                await useAccountStore.getState().recordAccountOutcome(accountId, 'failure', errorInfo.code);
            }
            console.error(`[Automation:${accountId}] ${cancelled ? '已取消' : '失败'}:`, errorMessage);
            if (cancelled) {
                await pauseAutomation(taskId, accountId, '用户已暂停，可随时重新执行');
            }
            else {
                setAccountAutomationState(accountId, 'failed', errorMessage, 'failed');
                await failAutomation(taskId, accountId, errorMessage, errorInfo);
            }
            const restartTask = pendingRestartTasksRef.current.get(taskId);
            if (restartTask) {
                pendingRestartTasksRef.current.delete(taskId);
                const updated = await updateTask(taskId, restartTask);
                if (updated)
                    message.success('提示词已更新，任务已重新加入队列');
            }
        }
        finally {
            abortControllersRef.current.delete(taskId);
            pendingRestartTasksRef.current.delete(taskId);
            runningRef.current.delete(accountId);
            await automationEngine.release(taskId);
            setTimeout(() => useTaskStore.getState().processQueue(), 0);
        }
    };
    // ---- 导航 ----
    const getActiveWebview = useCallback(() => {
        if (!activeAccount)
            return null;
        return registryRef.current.get(activeAccount.id) || null;
    }, [activeAccount]);
    const handleRefresh = useCallback(() => { getActiveWebview()?.reload(); }, [getActiveWebview]);
    const handleGoBack = useCallback(() => { const w = getActiveWebview(); if (w?.canGoBack())
        w.goBack(); }, [getActiveWebview]);
    const handleGoForward = useCallback(() => { const w = getActiveWebview(); if (w?.canGoForward())
        w.goForward(); }, [getActiveWebview]);
    const handleGoHome = useCallback(() => { getActiveWebview()?.loadURL('https://www.doubao.com/chat/'); }, [getActiveWebview]);
    if (!activeAccount) {
        return (<div className="browser-panel-empty">
        <div className="browser-empty-content">
          <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
            <rect x="4" y="8" width="56" height="40" rx="4" stroke="#38385a" strokeWidth="2"/>
            <path d="M4 16h56" stroke="#38385a" strokeWidth="2"/>
            <circle cx="12" cy="12" r="2" fill="#38385a"/>
            <circle cx="19" cy="12" r="2" fill="#38385a"/>
            <circle cx="26" cy="12" r="2" fill="#38385a"/>
          </svg>
          <p>选择一个账号以打开浏览器</p>
        </div>
      </div>);
    }
    const showOverlay = activeAutoState && activeAutoState !== 'idle' && activeAutoState !== 'completed' && activeAutoState !== 'failed';
    return (<div className="browser-panel">
      <div className="browser-toolbar">
        <div className="browser-nav-buttons">
          <button onClick={handleGoBack} title="后退">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M10.5 3L5.5 8l5 5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button onClick={handleGoForward} title="前进">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M5.5 3l5 5-5 5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button onClick={handleRefresh} title="刷新">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.5 8a5.5 5.5 0 00-10-2.5M2.5 8a5.5 5.5 0 0010 2.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
              <path d="M2 3v3h3M14 13v-3h-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button onClick={handleGoHome} title="回到豆包首页">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2 6l6-4.5L14 6v7.5a.5.5 0 01-.5.5h-3.5V9H6v5H2.5a.5.5 0 01-.5-.5V6z" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
        <div className="browser-url-bar">
          <span className="browser-url-text">doubao.com</span>
        </div>
        <Tooltip title="提取当前账号已授权的视频地址并下载">
          <button onClick={() => void handleExtractCurrentVideo()} title="提取官方无水印视频" disabled={manualVideoExtracting || !!accountBusy[activeAccount.id]} style={{
            width: 30,
            height: 30,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#b8b4ff',
            opacity: manualVideoExtracting || accountBusy[activeAccount.id] ? 0.45 : 1,
        }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </Tooltip>
        <div style={{ position: 'relative' }}>
          <button onClick={() => { setDownloadMenuOpen((open) => !open); refreshBrowserDownloads(); }} title="下载" aria-label="下载" style={{ width: 30, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#b8b4ff' }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          {downloadMenuOpen && <div style={{ position: 'absolute', top: 34, right: 34, zIndex: 30, width: 300, maxHeight: 360, overflowY: 'auto', padding: '10px 12px', background: '#202033', border: '1px solid #3c3b5c', borderRadius: 8, boxShadow: '0 12px 30px rgba(0,0,0,.35)', color: '#eee' }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>下载</div>
            {browserDownloads.length === 0 ? <div style={{ color: '#9996aa', fontSize: 12, padding: '12px 0' }}>暂无下载记录</div> : browserDownloads.slice(0, 8).map((item) => <div key={item.id} style={{ borderTop: '1px solid #34334b', padding: '9px 0', fontSize: 12 }}><div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.filename}</div><div style={{ color: item.state === 'completed' ? '#5bd590' : item.state === 'cancelled' || item.state === 'interrupted' || item.state === 'failed' ? '#e87979' : '#aaa7bc', marginTop: 3 }}>{item.state === 'completed' ? '已完成' : item.state === 'cancelled' ? '已取消' : item.state === 'interrupted' || item.state === 'failed' ? '下载失败' : '下载中'}</div>{item.error && <div style={{ color: '#f08a8a', marginTop: 3 }}>{item.error}</div>}<div style={{ display: 'flex', gap: 10, marginTop: 6 }}>{item.state === 'completed' && <><button onClick={() => void window.electronAPI.browserDownloads.open(item.filePath)} style={{ color: '#9cc8ff', background: 'none', border: 0, padding: 0, cursor: 'pointer' }}>打开文件</button><button onClick={() => void window.electronAPI.browserDownloads.reveal(item.filePath)} style={{ color: '#b8b4ff', background: 'none', border: 0, padding: 0, cursor: 'pointer' }}>打开所在文件夹</button></>}<button onClick={() => void window.electronAPI.browserDownloads.delete(item.id, item.state === 'completed').then(() => refreshBrowserDownloads())} style={{ color: '#f08a8a', background: 'none', border: 0, padding: 0, cursor: 'pointer' }}>删除记录</button></div></div>)}
          </div>}
        </div>
        <div style={{ position: 'relative' }}>
          <Tooltip title="扩展管理">
            <button onClick={() => setExtensionMenuOpen((open) => !open)} title="扩展管理" aria-label="扩展管理" style={{
            width: 30,
            height: 30,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: extensionLoaded ? '#8dd6ff' : '#8a879d',
        }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M9 3a3 3 0 1 0 0 6H3v6h6a3 3 0 1 0 6 0v-1h6V8h-6a3 3 0 1 0-6-5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/>
              </svg>
            </button>
          </Tooltip>
          {extensionMenuOpen && (<div style={{
                position: 'absolute', top: 34, right: 0, zIndex: 30, width: 220,
                padding: '12px 14px', background: '#202033', border: '1px solid #3c3b5c',
                borderRadius: 8, boxShadow: '0 12px 30px rgba(0,0,0,.35)', color: '#eee',
            }}>
              <div style={{ fontSize: 12, color: '#aaa7bc', marginBottom: 8 }}>当前账号扩展</div>
              <div style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: extensionLoaded ? '#43d17b' : '#e57474' }}/>
                <span>{extensionName}</span>
              </div>
              <div style={{ fontSize: 11, color: '#9b98ad', marginTop: 7 }}>
                {extensionLoaded ? '已加载，随当前账号页面生效' : '未加载，请刷新账号页面'}
              </div>
              <button disabled={!extensionLoaded} onClick={() => void window.electronAPI.extensions.openPopup(activeAccount.partition).then((result) => {
                if (!result.success)
                    message.warning(result.error || '扩展没有可打开的弹窗');
                else
                    setExtensionMenuOpen(false);
            })} style={{
                width: '100%', marginTop: 10, height: 28, borderRadius: 5,
                border: '1px solid #4b4a72', background: '#2b2a4a', color: '#ddd9ff',
                cursor: extensionLoaded ? 'pointer' : 'not-allowed', opacity: extensionLoaded ? 1 : 0.5,
            }}>
                打开扩展窗口
              </button>
            </div>)}
        </div>
      </div>

      <div className="browser-viewport">
        {activeLoading && (<div className="browser-loading-overlay">
            <div className="browser-loading-spinner"/>
            <span>{loadText}</span>
          </div>)}

        {showOverlay && (<div className="automation-overlay">
            <div className="automation-indicator">
              <div className="automation-spinner"/>
              <span>{activeAutoMsg}</span>
            </div>
          </div>)}

        {activeAutoState === 'completed' && (<div className="automation-toast completed">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="9" r="8" stroke="#34d399" strokeWidth="2"/>
              <path d="M5.5 9l2.5 2.5 4.5-5" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span>{activeAutoMsg}</span>
          </div>)}

        {activeAutoState === 'failed' && (<div className="automation-toast failed">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="9" r="8" stroke="#fb7185" strokeWidth="2"/>
              <path d="M6 6l6 6M12 6l-6 6" stroke="#fb7185" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <span>执行失败: {activeAutoMsg}</span>
          </div>)}

        <div ref={poolRef} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}/>
      </div>
    </div>);
};
function waitForWebviewReady(webview, timeoutMs) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const poll = async () => {
            if (Date.now() - startTime >= timeoutMs) {
                reject(new Error('页面就绪检测超时（' + timeoutMs + 'ms）'));
                return;
            }
            try {
                const ready = await waitForChatReady(webview, 3000);
                if (ready)
                    resolve();
                else
                    setTimeout(poll, 1000);
            }
            catch {
                setTimeout(poll, 1000);
            }
        };
        poll();
    });
}
/** 等待豆包 AI 回复完成（消息区新增 AI 消息且无 loading）。返回 false = 超时。 */
async function waitForDoubaoAiReply(webview, timeoutMs) {
    const startTime = Date.now();
    // 记录发送前的消息数基线
    let before = 0;
    try {
        before = await webview.executeJavaScript(`document.querySelectorAll('[class*="message-item"], [class*="chat-message"], [data-testid*="message"]').length`);
    }
    catch { /* ignore */ }
    while (Date.now() - startTime < timeoutMs) {
        try {
            const state = await webview.executeJavaScript(`(function(){
                var msgs = document.querySelectorAll('[class*="message-item"], [class*="chat-message"], [data-testid*="message"]');
                var loading = document.querySelector('[class*="loading"], [class*="streaming"], [class*="thinking"], [class*="generating"]');
                var lastText = msgs.length ? (msgs[msgs.length - 1].innerText || '') : '';
                return { count: msgs.length, loading: !!(loading && loading.offsetParent !== null), lastText: lastText.slice(0, 80) };
            })()`);
            if (state.count > before && !state.loading && state.lastText) {
                console.log('[Automation] 豆包已回复，继续发送分镜提示词:', state.lastText.slice(0, 40));
                return true;
            }
        }
        catch { /* 页面可能还在切换 */ }
        await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
}
function sleepWithAbort(ms, signal) {
    if (signal.aborted) {
        return Promise.reject(new DOMException('任务已取消', 'AbortError'));
    }
    return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
            signal.removeEventListener('abort', handleAbort);
            resolve();
        }, ms);
        const handleAbort = () => {
            window.clearTimeout(timer);
            reject(new DOMException('任务已取消', 'AbortError'));
        };
        signal.addEventListener('abort', handleAbort, { once: true });
    });
}
export default BrowserPanel;
//# sourceMappingURL=BrowserPanel.js.map