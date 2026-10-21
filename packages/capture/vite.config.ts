import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'FlaxiaCapture',
      formats: ['es', 'iife'],
      fileName: (format) => `capture-bridge${format === 'es' ? '.js' : '.iife.js'}`,
    },
    emptyOutDir: true,
    sourcemap: true,
    minify: true,
    rollupOptions: {
      external: [],
    },
  },
});
