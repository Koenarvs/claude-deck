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
    host: true, // expose Vite dev server on all interfaces for LAN access
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
    exclude: ['**/node_modules/**', '**/.claude/worktrees/**', '**/dist/**'],
    projects: [
      {
        extends: true,
        test: {
          name: 'client',
          environment: 'jsdom',
          setupFiles: ['./tests/setup-dom.ts'],
          include: ['tests/client/**/*.test.{ts,tsx}', 'tests/shared/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'server',
          environment: 'node',
          setupFiles: [],
          include: ['tests/server/**/*.test.ts'],
        },
      },
    ],
  },
});
