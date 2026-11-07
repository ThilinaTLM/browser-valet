// Bundles the extension into dist/ (load dist/ as an unpacked extension).
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('static', 'dist', { recursive: true });

const options = {
  entryPoints: { background: 'src/background/index.ts', popup: 'src/popup/popup.ts' },
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  sourcemap: 'linked',
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
