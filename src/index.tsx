/**
 * src/index.tsx
 * React 渲染进程入口
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import './styles/global.css';

// 浏览器预览没有 Electron preload 时，提供只读演示数据；桌面版会使用真实 API。
if (!window.electronAPI) {
  const now = new Date().toISOString();
  const demoAccount = {
    id: 'demo-account',
    name: '演示账号',
    avatar: '',
    partition: 'demo-account',
    status: 'idle',
    pinned: true,
    createdAt: now,
    updatedAt: now,
  };
  const demoProject = {
    id: 'default-project',
    name: '默认项目',
    description: '浏览器预览项目',
    color: '#6c5ce7',
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
  const ok = async () => ({ success: true });
  window.electronAPI = {
    projects: { list: async () => [demoProject], add: async () => ({ success: true, project: demoProject }), update: async () => ({ success: true, project: demoProject }), delete: ok },
    accounts: { list: async () => [demoAccount], add: async () => ({ success: true, account: demoAccount }), update: async () => ok(), delete: ok, refresh: async () => ok(), setStatus: ok, setPinned: ok, updateSeedanceQuota: async () => ({ success: true, account: demoAccount }), updateHealth: async () => ({ success: true, account: demoAccount }), updateScheduling: async () => ({ success: true, account: demoAccount }), getPartition: async () => 'persist:doubao_demo-account' },
    tasks: { list: async () => [], add: async () => ({ success: true, tasks: [] }), assign: ok, updateStatus: ok, updateRuntime: async () => ({ success: true }), acquireLock: async () => ({ success: true }), renewLock: async () => ({ success: true }), releaseLock: ok, importCsv: async () => ({ success: true, tasks: [] }), update: async () => ({ success: true }), delete: ok, retry: async () => ({ success: true }), batchPause: ok, getCompletedOutputs: async () => [], selectImages: async () => ({ canceled: true, filePaths: [] }), selectAudio: async () => ({ canceled: true, filePath: null }), readFileAsBase64: async () => ({ success: false }), downloadOutputs: async () => ({ success: true, jobs: [] }), listDownloads: async () => [], exportDiagnostics: async () => ({ success: true }), validateArtifact: async () => ({ success: true }), saveAdapterReport: ok, selectAdapterRules: async () => ({ canceled: true }), selectSaveDir: async () => ({ canceled: true }) },
    settings: { get: async () => ({ taskTemplates: [], downloadDir: '' }), save: ok },
    logs: { list: async () => [], append: ok, clear: ok },
    system: { getVersion: async () => '2.3.0-preview', checkIntegrity: async () => ({ success: true }), exportBackup: async () => ({ success: true }), restoreBackup: async () => ({ success: true }), exportProject: async () => ({ success: true }), checkUpdate: async () => ({ success: true }), minimize: () => {}, toggleMaximize: () => {}, close: () => {} },
  } as any;
}

// ==================== Ant Design 深色主题配置 ====================

const darkTheme = {
  algorithm: theme.darkAlgorithm,
  token: {
    // 品牌色 - 紫色系
    colorPrimary: '#6c5ce7',
    colorInfo: '#6c5ce7',
    colorSuccess: '#34d399',
    colorWarning: '#fbbf24',
    colorError: '#f87171',
    // 基础色
    colorBgBase: '#0f0f14',
    colorBgContainer: '#1e1e2e',
    colorBgElevated: '#24243a',
    colorBorder: '#2a2a3e',
    colorTextBase: '#e8e8f0',
    colorTextSecondary: '#9898b8',
    // 圆角
    borderRadius: 8,
    // 字体
    fontFamily: "'Inter', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  components: {
    Button: {
      colorPrimary: '#6c5ce7',
      algorithm: true,
    },
    Modal: {
      colorBgElevated: '#1e1e2e',
    },
    Dropdown: {
      colorBgElevated: '#1e1e2e',
    },
    Input: {
      colorBgContainer: '#1a1a24',
    },
    Tag: {
      borderRadiusSM: 9999,
    },
  },
};

// ==================== 渲染 ====================

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider theme={darkTheme} locale={zhCN}>
      <App />
    </ConfigProvider>
  </React.StrictMode>
);
