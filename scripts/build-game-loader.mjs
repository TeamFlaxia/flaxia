import { build } from 'vite';

await build({
  configFile: false,
  publicDir: false,
  build: {
    outDir: 'sandbox/game-loader/generated',
    emptyOutDir: true,
    lib: { entry: 'src/lib/game-loader-unzip-worker.ts', formats: ['es'], fileName: () => 'unzip-worker.js' },
    sourcemap: false,
  },
});
