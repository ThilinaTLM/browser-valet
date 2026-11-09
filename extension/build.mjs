// Bundles the extension into dist/ (load dist/ as an unpacked extension).
import * as esbuild from 'esbuild';
import { copyFile, cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('static', 'dist', { recursive: true });

// Nerve's UI (Outfit) and code (Iosevka) fonts, bundled so the popup makes no network requests.
const FONTS = {
  outfit: ['400', '500', '600'],
  iosevka: ['400', '500'],
};
await mkdir('dist/fonts', { recursive: true });
for (const [family, weights] of Object.entries(FONTS)) {
  for (const weight of weights) {
    const file = `${family}-latin-${weight}-normal.woff2`;
    await copyFile(`node_modules/@fontsource/${family}/files/${file}`, `dist/fonts/${file}`);
  }
}

// pairing.json only ever exists in bctl's managed folder, never in a build.
await rm('dist/pairing.json', { force: true });

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
