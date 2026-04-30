import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './src/shared'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4100',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:4100',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist/client',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup-dom.ts'],
    exclude: ['**/node_modules/**', '**/.claude/worktrees/**', '**/dist/**'],
  },
});
