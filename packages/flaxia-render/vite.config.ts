import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  build: {
    outDir: 'dist',
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      name: 'FlaxiaRender',
      formats: ['es', 'iife'],
      fileName: (format) => (format === 'es' ? 'render.js' : 'render.iife.js'),
    },
    emptyOutDir: true,
    sourcemap: true,
    minify: true,
  },
});
