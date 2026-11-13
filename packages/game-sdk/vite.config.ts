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
      name: 'FlaxiaGame',
      formats: ['es', 'iife'],
      fileName: (format) => `game-sdk${format === 'es' ? '.js' : '.iife.js'}`,
    },
    emptyOutDir: true,
    sourcemap: true,
    minify: true,
    rollupOptions: {
      external: [],
    },
  },
});
