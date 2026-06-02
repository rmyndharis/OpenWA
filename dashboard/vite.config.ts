import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  appType: 'spa',
  define: {
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION || '0.2.1'),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    port: 2886,
    proxy: {
      '/api': {
        target: 'http://localhost:2785',
        changeOrigin: true,
        secure: false,
        logLevel: 'debug',
      },
    },
    open: true, // Automatically open browser on dev start
  },
});