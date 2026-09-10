import { build as viteBuild } from 'vite';
import { build } from 'esbuild';
await viteBuild({ build: { chunkSizeWarningLimit: 1000 } });
await build({
  entryPoints: ['runtime/worker.js'],
  outfile: 'dist/runtime-worker.js',
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: true,
});
