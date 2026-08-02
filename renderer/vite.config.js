import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // Electron file:// 加载必须相对路径
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5199 }
});
