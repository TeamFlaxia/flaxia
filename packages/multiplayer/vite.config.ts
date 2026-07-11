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
      name: 'FlaxiaMultiplayer',
      formats: ['es', 'iife'],
      fileName: (format) => `multiplayer-sdk${format === 'es' ? '.js' : '.iife.js'}`,
    },
    emptyOutDir: true,
    sourcemap: true,
    minify: true,
    rollupOptions: {
      external: [],
    },
  },
});
