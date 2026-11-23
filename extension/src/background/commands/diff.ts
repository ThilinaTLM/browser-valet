// `diff <subcommand>`: compare page states. Each subcommand is one entry in SUBCOMMANDS.

import { type Args, type Command, type Ctx, type Flag, REDACTED, type Result } from '../command';
import { base64Blob } from '../base64';
import { captureKey, getDiffBaseline, setDiffBaseline } from '../capture-compare';
import { evaluate } from '../dom';
import * as cdp from '../cdp';
import { UserError } from '../errors';
import { diffImages } from '../image-diff';
import { fullPage, toBase64, viewport } from './inspection';

/**
 * One `diff` subcommand. Each brings its own flags and redaction: `show` positionals after the
 * subcommand name and the `showFlags` values reach the activity log, everything else is `•••`
 * (a selector or a path may be page-derived text, see security.md).
 */
interface Subcommand {
  usage: string;
  flags: Flag[];
  show?: number;
  showFlags?: string[];
  run(ctx: Ctx, a: Args): Promise<Result>;
}

const SUBCOMMANDS: Record<string, Subcommand> = {
  screenshot: {
    usage: 'diff screenshot [-o <file>] [-t <0-1>] [-f|--full]',
    flags: [
      { name: 'baseline', short: 'b', type: 'string', desc: 'Not supported (see details)' },
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
      { name: 'full', short: 'f', type: 'bool', desc: 'Full page screenshot' },
    ],
    showFlags: ['output', 'threshold'],
    run: diffScreenshot,
  },
};

/** Flags of all subcommands (a name shared by several is declared once). */
const allFlags = (): Flag[] => {
  const seen = new Map<string, Flag>();
  for (const s of Object.values(SUBCOMMANDS))
    for (const f of s.flags) if (!seen.has(f.name)) seen.set(f.name, f);
  return [...seen.values()];
};

export const diffCommands: Command[] = [
  {
    name: 'diff',
    group: 'Reading',
    usage: Object.values(SUBCOMMANDS)
      .map((s) => s.usage)
      .join(' | '),
    summary: 'Pixel diff of the page against the last screenshot (changes in red)',
    details:
      'diff screenshot compares the page with the last screenshot of the same scope (viewport or --full) taken in this tab by `screenshot` or `diff screenshot`, and writes a diff image: the baseline in grey, changed pixels in red. The first call only records the baseline. The baseline lives in memory: it is lost when the tab is closed or revoked and when the extension restarts, and captures over ~12 MB (PNG) are not kept. --baseline <file> is not supported: the extension cannot read local files. Exits 0 even when pixels differ; read the text or JSON (diffPath, differentPixels, totalPixels, mismatchPercentage, match, dimensionMismatch).',
    examples: ['bvl screenshot && bvl click @e3 && bvl diff screenshot -o diff.png'],
    flags: allFlags(),
    log(a) {
      const name = a.pos[0];
      const sub = name === undefined ? undefined : SUBCOMMANDS[name];
      const out: string[] = name === undefined ? [] : [sub ? name : REDACTED];
      const show = sub?.show ?? 0;
      out.push(...a.pos.slice(1).map((p, i) => (i < show ? p : REDACTED)));
      for (const [n, v] of a.given()) {
        out.push(`--${n}`);
        if (v !== true) out.push(sub?.showFlags?.includes(n) ? v : REDACTED);
      }
      return out;
    },
    async run(ctx, a) {
      const name = a.pos[0];
      const sub = name === undefined ? undefined : SUBCOMMANDS[name];
      if (!sub) {
        throw new UserError(
          name === undefined
            ? `Missing diff subcommand (${Object.keys(SUBCOMMANDS).join(', ')})`
            : `Unknown diff subcommand '${name}' (available: ${Object.keys(SUBCOMMANDS).join(', ')})`,
          'bad_args',
        );
      }
      return sub.run(ctx, a);
    },
  },
];

interface Decoded {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Decoded RGBA of a 16 MP image is 64 MB, and a diff holds three of them. */
const MAX_PIXELS = 16_000_000;

function checkSize(width: number, height: number): void {
  if (width * height > MAX_PIXELS) {
    throw new UserError(
      `Page too large to diff (${String(width)}x${String(height)} px, limit ${String(MAX_PIXELS / 1e6)} megapixels): use the viewport instead of --full, or a smaller viewport`,
    );
  }
}

async function decode(base64: string, format: 'png' | 'jpeg'): Promise<Decoded> {
  const bmp = await createImageBitmap(await base64Blob(base64, `image/${format}`));
  checkSize(bmp.width, bmp.height);
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
  const extra = a.pos[1];
  if (extra !== undefined) throw new UserError(`Unexpected argument: ${extra}`, 'bad_args');
  if (a.has('baseline')) {
    throw new UserError(
      '--baseline <file> is not supported: the extension cannot read local files. Omit --baseline to compare with the last screenshot taken in this tab',
      'bad_args',
    );
  }
  const thresholdArg = a.str('threshold');
  const threshold = thresholdArg === undefined ? 0.1 : Number(thresholdArg);
  if (Number.isNaN(threshold) || thresholdArg?.trim() === '')
    throw new UserError(`Invalid threshold value: ${thresholdArg ?? ''}`, 'bad_args');
  if (threshold < 0 || threshold > 1) {
    throw new UserError(`Threshold must be between 0 and 1, got ${thresholdArg ?? ''}`, 'bad_args');
  }
  const outArg = a.str('output');

  const id = await ctx.tab();
  const full = a.has('full');
  const key = captureKey(id, full ? 'diff:full' : 'diff:view');
  const prev = getDiffBaseline(key);

  if (full) {
    const m = await cdp.send<{ cssContentSize: { width: number; height: number } }>(
      id,
      'Page.getLayoutMetrics',
    );
    const dpr = Number((await evaluate(id, 'devicePixelRatio')).value) || 1;
    checkSize(
      Math.ceil(m.cssContentSize.width * dpr),
      Math.ceil(Math.min(m.cssContentSize.height, 32000 / dpr) * dpr),
    );
  }
  let data: string;
  let truncated = false;
  if (full) ({ data, truncated } = await fullPage(id, 'png'));
  else ({ data } = await viewport(id, 'png'));
  setDiffBaseline(key, data, truncated);
  const warning = truncated ? 'Very tall page: the full-page screenshot was truncated' : undefined;

  if (!prev) {
    return {
      text: `✓ No earlier ${full ? 'full-page ' : ''}screenshot to compare with: baseline recorded${outArg === undefined ? '' : ' (no diff image written)'}. Run \`diff screenshot\` again after the change`,
      data: {
        baselineRecorded: true,
        diffPath: null,
        differentPixels: null,
        totalPixels: null,
        mismatchPercentage: null,
        match: null,
        dimensionMismatch: null,
      },
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
