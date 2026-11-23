// `diff <subcommand>`: compare page states. Each subcommand is one entry in SUBCOMMANDS.

import type { Args, Command, Ctx, Result } from '../command';
import { captureKey, getDiffBaseline, setDiffBaseline } from '../capture-compare';
import { UserError } from '../errors';
import { diffImages } from '../image-diff';
import { fullPage, toBase64, viewport } from './inspection';

type Subcommand = (ctx: Ctx, a: Args) => Promise<Result>;

const SUBCOMMANDS: Record<string, Subcommand> = {
  screenshot: diffScreenshot,
};

export const diffCommands: Command[] = [
  {
    name: 'diff',
    group: 'Reading',
    usage: 'diff screenshot [-o <file>] [-t <0-1>] [--full]',
    summary: 'Pixel diff of the page against the last screenshot (changes in red)',
    details:
      'diff screenshot compares the page with the last screenshot of the same scope (viewport or --full) taken in this tab by `screenshot` or `diff screenshot`, and writes a diff image: the baseline in grey, changed pixels in red. The first call only records the baseline. Baseline files (--baseline <file>) are not supported: the extension cannot read local files. Exits 0 even when pixels differ; read the text or JSON (diffPath, differentPixels, totalPixels, mismatchPercentage, match, dimensionMismatch).',
    examples: ['bvl screenshot && bvl click @e3 && bvl diff screenshot -o diff.png'],
    show: Infinity,
    showFlags: ['output', 'threshold'],
    flags: [
      { name: 'baseline', short: 'b', type: 'string', desc: 'Not supported yet (see details)' },
      {
        name: 'output',
        short: 'o',
        type: 'string',
        desc: 'Path for the diff image (default: temp file)',
      },
      {
        name: 'threshold',
        short: 't',
        type: 'string',
        desc: 'Colour distance tolerated, 0-1 (default 0.1)',
      },
      { name: 'full', type: 'bool', desc: 'Full page screenshot' },
    ],
    async run(ctx, a) {
      const sub = a.pos[0];
      const run = sub === undefined ? undefined : SUBCOMMANDS[sub];
      if (!run) {
        throw new UserError(
          sub === undefined
            ? 'Missing diff subcommand: screenshot'
            : `Unknown diff subcommand '${sub}' (available: ${Object.keys(SUBCOMMANDS).join(', ')})`,
          'bad_args',
        );
      }
      return run(ctx, a);
    },
  },
];

interface Decoded {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

async function decode(base64: string, format: 'png' | 'jpeg'): Promise<Decoded> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: `image/${format}` }));
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('Canvas unavailable');
  g.drawImage(bmp, 0, 0);
  return {
    width: bmp.width,
    height: bmp.height,
    data: g.getImageData(0, 0, bmp.width, bmp.height).data,
  };
}

async function encodePng(img: Decoded): Promise<string> {
  const canvas = new OffscreenCanvas(img.width, img.height);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('Canvas unavailable');
  g.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return toBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** Upstream prints 0 as `0`, otherwise two decimals. */
const percent = (p: number): string => (p === 0 ? '0' : p.toFixed(2));

async function diffScreenshot(ctx: Ctx, a: Args): Promise<Result> {
  if (a.has('baseline')) {
    throw new UserError(
      '--baseline <file> is not supported: the extension cannot read local files. Omit --baseline to compare with the last screenshot taken in this tab',
      'bad_args',
    );
  }
  if (a.has('threshold') && a.str('threshold') === undefined)
    throw new UserError('Missing --threshold value', 'bad_args');
  const threshold = a.num('threshold') ?? 0.1;
  if (threshold < 0 || threshold > 1) {
    throw new UserError(`Threshold must be between 0 and 1, got ${String(threshold)}`, 'bad_args');
  }
  if (a.has('output') && a.str('output') === undefined)
    throw new UserError('Missing --output value', 'bad_args');
  const outArg = a.str('output');

  const id = await ctx.tab();
  const full = a.has('full');
  const key = captureKey(id, full ? 'diff:full' : 'diff:view');
  const prev = getDiffBaseline(key);

  let data: string;
  let truncated = false;
  if (full) ({ data, truncated } = await fullPage(id, 'png'));
  else ({ data } = await viewport(id, 'png'));
  setDiffBaseline(key, { data, format: 'png' });
  const warning = truncated ? 'Very tall page: the full-page screenshot was truncated' : undefined;

  if (!prev) {
    return {
      text: `✓ No earlier ${full ? 'full-page ' : ''}screenshot to compare with: baseline recorded. Run \`diff screenshot\` again after the change`,
      data: { baselineRecorded: true, diffPath: null, match: null },
      warning,
    };
  }

  const diff = diffImages(
    await decode(prev.data, prev.format),
    await decode(data, 'png'),
    threshold,
  );
  let diffPath: string | null = null;
  if (diff.image && (outArg !== undefined || !diff.match)) {
    diffPath = outArg
      ? ctx.path(outArg)
      : ctx.tmpPath('bvl', 'screenshots', `diff-${Date.now()}.png`);
    ctx.files.push({ path: diffPath, base64: await encodePng(diff.image) });
  }

  const lines = [
    diff.match
      ? `✓ Images match (${percent(diff.mismatchPercentage)}% difference)`
      : `✗ ${percent(diff.mismatchPercentage)}% pixels differ`,
  ];
  if (diffPath) lines.push(`  Diff image: ${diffPath}`);
  if (diff.dimensionMismatch) {
    const { expected: e, actual: c } = diff.dimensionMismatch;
    lines.push(
      `  Size changed: ${String(e.width)}x${String(e.height)} -> ${String(c.width)}x${String(c.height)}`,
    );
  }
  lines.push(
    `  ${String(diff.differentPixels)} different / ${String(diff.totalPixels)} total pixels`,
  );
  return {
    text: lines.join('\n'),
    data: {
      diffPath,
      differentPixels: diff.differentPixels,
      totalPixels: diff.totalPixels,
      mismatchPercentage: diff.mismatchPercentage,
      match: diff.match,
      dimensionMismatch: diff.dimensionMismatch,
    },
    warning,
  };
}
