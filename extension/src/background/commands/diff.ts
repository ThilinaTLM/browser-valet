// `diff <subcommand>`: compare page states (`snapshot`, `screenshot`, `url`). Each subcommand is one entry
// in SUBCOMMANDS.

import { Args, type Command, type Ctx, type Flag, REDACTED, type Result } from '../command';
import { base64Blob } from '../base64';
import { captureKey, getDiffBaseline, setDiffBaseline } from '../capture-compare';
import { evaluate } from '../dom';
import { state } from '../state';
import { snapshot } from '../snapshot';
import {
  formatUnifiedDiff,
  getLastSnapshot,
  setLastSnapshot,
  snapshotKey,
  stripBoundaryLines,
  stripRef,
  unifiedDiff,
} from '../snapshot-diff';
import * as cdp from '../cdp';
import { UserError } from '../errors';
import { diffImages } from '../image-diff';
import { fullPage, toBase64, viewport, waitNetworkIdle } from './inspection';
import { assertNavigable } from '../guardrails';
import { navigationCommands, normalizeUrl } from './navigation';

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
  snapshot: {
    usage: 'diff snapshot [--stdin] [-s <selector>] [-c] [-d N]',
    flags: [
      { name: 'stdin', type: 'bool', desc: 'Read the baseline snapshot text from stdin' },
      { name: 'baseline', short: 'b', type: 'string', desc: 'Not supported (see details)' },
      { name: 'selector', short: 's', type: 'string', desc: 'Scope to an element (CSS or @ref)' },
      { name: 'compact', short: 'c', type: 'bool', desc: 'Drop empty structural nodes' },
      { name: 'depth', short: 'd', type: 'string', desc: 'Limit tree depth' },
    ],
    // Like `snapshot`: the depth and selector are logged, a baseline never is.
    showFlags: ['depth', 'selector'],
    run: diffSnapshot,
  },
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
  url: {
    usage:
      'diff url <url1> <url2> [--screenshot] [--full] [--wait-until load|domcontentloaded|networkidle] [-s <selector>] [-c] [-d N]',
    flags: [
      { name: 'screenshot', type: 'bool', desc: 'Also compare screenshots' },
      {
        name: 'wait-until',
        type: 'string',
        desc: 'load | domcontentloaded | networkidle (default load)',
      },
    ],
    // Like `open`, both URLs are logged; selectors are page-derived text and are not.
    show: 2,
    showFlags: ['depth', 'wait-until'],
    run: diffUrl,
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
    summary:
      'Compare the page with the last snapshot (text) or screenshot (pixels), or two URLs (diff url)',
    details:
      'diff snapshot takes a snapshot and prints a unified diff against the last snapshot taken on this tab with the same options (-c, -d, -s, and the frame); a snapshot taken with -i or -u is not a baseline. Refs are ignored when comparing, so a reload or navigation does not make every line differ; the printed lines keep their refs. Without an earlier snapshot the whole tree shows as added (with a warning). --stdin compares against a text baseline instead (`bvl snapshot > before.txt`, later `bvl diff snapshot --stdin < before.txt`); -b <file> is not supported because the extension cannot read files. The new snapshot becomes the baseline for the next diff. --json: {diff, additions, removals, unchanged, changed}. \n\n' +
      'diff screenshot compares the page with the last screenshot of the same scope (viewport or --full) taken in this tab by `screenshot` or `diff screenshot`, and writes a diff image: the baseline in grey, changed pixels in red. The first call only records the baseline. The baseline lives in memory: it is lost when the tab is closed or revoked and when the extension restarts, and captures over ~12 MB (PNG) are not kept. --baseline <file> is not supported: the extension cannot read local files. Exits 0 even when pixels differ; read the text or JSON (diffPath, differentPixels, totalPixels, mismatchPercentage, match, dimensionMismatch).\n\n' +
      "diff url <u1> <u2> opens each URL in the session's agent tab exactly like `open` (never a tab the user shared; allowed-domains and new-site confirmation apply, and both URLs are checked before the first navigation), snapshots it, then diffs the two snapshots with refs ignored. --screenshot also compares PNG captures of the two pages (--full for the whole page) and writes a diff image when they differ. -s, -c and -d scope the snapshots. --wait-until: `load` and `domcontentloaded` wait for the load event (as `open` does); `networkidle` additionally waits until no new resource request started for 500 ms (the same heuristic as `wait --load networkidle`, bounded by --timeout per page). The tab stays on <u2>, so refs from before the command are gone. --json: {diff: {diff, additions, removals, unchanged, changed, identical, deletions}, url1, url2, snapshot1, snapshot2, screenshot?}.",
    examples: [
      'bvl diff snapshot',
      'bvl diff snapshot --stdin < before.txt',
      'bvl diff url https://staging.example.com https://example.com --screenshot',
      'bvl screenshot && bvl click @e3 && bvl diff screenshot -o diff.png',
    ],
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

/** Unified diff of two snapshot texts, ignoring refs when comparing (printed lines keep them). */
function diffSnapshotTexts(baseline: string, current: string) {
  const before = stripBoundaryLines(
    baseline === '' ? [] : baseline.replace(/\r?\n$/, '').split(/\r?\n/),
  );
  const after = current.split('\n');
  return unifiedDiff(before.map(stripRef), after.map(stripRef), before, after);
}

async function diffSnapshot(ctx: Ctx, a: Args): Promise<Result> {
  if (a.pos.length > 1) {
    throw new UserError(
      `Unexpected argument ${a.pos[1] ?? ''}: to scope the diff use -s <selector|@ref>. Usage: ${String(SUBCOMMANDS.snapshot?.usage)}`,
      'bad_args',
    );
  }
  if (a.str('baseline') !== undefined) {
    throw new UserError(
      '-b <file> is not supported (the extension cannot read files). Pipe the baseline instead: bvl diff snapshot --stdin < before.txt',
      'bad_args',
    );
  }
  const useStdin = a.has('stdin');
  const stdin = ctx.req.stdin ?? '';
  if (useStdin && stdin.trim() === '') {
    throw new UserError(
      '--stdin needs the baseline snapshot text on stdin (bvl diff snapshot --stdin < before.txt)',
      'bad_args',
    );
  }
  const id = await ctx.tab();
  const opts = {
    interactive: false,
    compact: a.has('compact'),
    depth: a.num('depth'),
    scope: a.str('selector'),
    urls: false,
  };
  const key = snapshotKey(id, opts, state.frames[id]?.frameId);
  const last = useStdin ? undefined : getLastSnapshot(key);
  const baseline = useStdin ? stdin : (last ?? '');
  const snap = await snapshot(id, { ...opts, session: ctx.session });
  setLastSnapshot(key, snap.text);
  const d = diffSnapshotTexts(baseline, snap.text);
  return {
    text: formatUnifiedDiff(d),
    data: d,
    ...(!useStdin && last === undefined
      ? {
          warning:
            'no earlier snapshot with these options; showing the whole tree as added (-i and -u snapshots do not count)',
        }
      : {}),
  };
}

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

/** The diff always works on lossless captures, whatever `--screenshot-format` says. */
const PNG = { format: 'png', quality: undefined } as const;

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

  const { data, truncated } = await capture(id, full);
  setDiffBaseline(key, data, truncated);
  const warning = truncated ? TRUNCATED : undefined;

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

  const r = await compareCaptures(ctx, prev.data, prev.format, data, threshold, outArg);
  return { text: r.text, data: r.data, warning };
}

const TRUNCATED = 'Very tall page: the full-page screenshot was truncated';

/** A lossless capture of the page; a page too large to decode is refused before capturing. */
async function capture(id: number, full: boolean): Promise<{ data: string; truncated: boolean }> {
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
    return fullPage(id, PNG);
  }
  const { data } = await viewport(id, PNG);
  return { data, truncated: false };
}

/** Diff two captures; writes the diff image (always with `outArg`, else only when they differ). */
async function compareCaptures(
  ctx: Ctx,
  beforeData: string,
  beforeFormat: 'png' | 'jpeg',
  afterData: string,
  threshold: number,
  outArg: string | undefined,
): Promise<{ text: string; data: Record<string, unknown> }> {
  const diff = diffImages(
    await decode(beforeData, beforeFormat),
    await decode(afterData, 'png'),
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
  };
}

const WAIT_UNTIL = ['load', 'domcontentloaded', 'networkidle'];

/** Navigate the session's agent tab like `open` does (policy, confirmation, timeout, warnings). */
async function openAgentTab(ctx: Ctx, url: string, waitUntil: string): Promise<string[]> {
  const open = navigationCommands.find((c) => c.name === 'open');
  const r = await open?.run(ctx, new Args([url], new Map()));
  // `open` waits for the load event, which covers `load` and `domcontentloaded`.
  if (waitUntil === 'networkidle') await waitNetworkIdle(ctx, await ctx.tab());
  return [r?.warning ?? []].flat();
}

async function diffUrl(ctx: Ctx, a: Args): Promise<Result> {
  const [, url1, url2, extra] = a.pos;
  if (url1 === undefined || url2 === undefined) {
    throw new UserError(`Usage: ${String(SUBCOMMANDS.url?.usage)}`, 'bad_args');
  }
  if (extra !== undefined) throw new UserError(`Unexpected argument: ${extra}`, 'bad_args');
  const waitUntil = a.str('wait-until') ?? 'load';
  if (!WAIT_UNTIL.includes(waitUntil)) {
    throw new UserError(
      `--wait-until must be ${WAIT_UNTIL.join('|')}, got ${waitUntil}`,
      'bad_args',
    );
  }
  const depth = a.num('depth');
  if (depth !== undefined && (!Number.isInteger(depth) || depth < 0)) {
    throw new UserError('Depth must be a non-negative integer', 'bad_args');
  }
  // Both URLs are checked before anything navigates, so a blocked second URL costs no request.
  assertNavigable(ctx, normalizeUrl(url1));
  assertNavigable(ctx, normalizeUrl(url2));

  const withShot = a.has('screenshot');
  const full = a.has('full');
  const opts = {
    interactive: false,
    compact: a.has('compact'),
    depth,
    scope: a.str('selector'),
    urls: false,
  };
  const warnings: string[] = [];

  const visit = async (url: string) => {
    warnings.push(...(await openAgentTab(ctx, url, waitUntil)));
    const id = await ctx.tab(); // `open` set it: an agent tab, never the user's shared one
    const snap = await snapshot(id, { ...opts, session: ctx.session });
    const shot = withShot ? await capture(id, full) : undefined;
    return { id, text: snap.text, shot };
  };
  const first = await visit(url1);
  const second = await visit(url2);

  // The tab stays on u2: its snapshot and capture are the baselines for the next plain diff.
  const frame = state.frames[second.id]?.frameId;
  setLastSnapshot(snapshotKey(second.id, opts, frame), second.text);
  const d = diffSnapshotTexts(first.text, second.text);
  const parts = ['Snapshot diff:', formatUnifiedDiff(d)];
  const data: Record<string, unknown> = {
    diff: { ...d, identical: !d.changed, deletions: d.removals },
    url1,
    url2,
    snapshot1: first.text,
    snapshot2: second.text,
  };
  if (first.shot && second.shot) {
    setDiffBaseline(
      captureKey(second.id, full ? 'diff:full' : 'diff:view'),
      second.shot.data,
      second.shot.truncated,
    );
    const r = await compareCaptures(ctx, first.shot.data, 'png', second.shot.data, 0.1, undefined);
    parts.push('', 'Screenshot diff:', r.text);
    data.screenshot = r.data;
    if (first.shot.truncated || second.shot.truncated) warnings.push(TRUNCATED);
  }
  return { text: parts.join('\n'), data, ...(warnings.length ? { warning: warnings } : {}) };
}
