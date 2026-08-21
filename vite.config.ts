import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vite 配置：仅用于渲染进程（React 前端）
export default defineConfig({
  plugins: [react()],
  // 开发时 Electron 通过 loadURL 加载此地址
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'zustand'],
          antd: ['antd', '@ant-design/icons'],
        },
      },
    },
  },
  esbuild: {
    // .js 文件中可能含 JSX 语法（如 App.js），强制按 JSX 解析
    loader: 'jsx' as any,
    include: [/src\/.*\.[jt]sx?$/, /src\/.*\.js$/],
    exclude: [],
  },
  optimizeDeps: {
    esbuildOptions: { loader: { '.js': 'jsx' } },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
