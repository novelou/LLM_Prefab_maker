import { build } from 'esbuild';
import { createServer as createViteServer } from 'vite';
import { startServer } from '../server/index.mjs';
await build({
  entryPoints: ['runtime/worker.js'],
  outfile: 'dist/runtime-worker.js',
  bundle: true,
  format: 'iife',
  target: 'es2022',
});
const vite = await createViteServer({
  server: { middlewareMode: true, hmr: false },
  appType: 'spa',
});
await startServer({ vite });
