import { type Command, type Ctx, type Result } from '../command';
import * as cdp from '../cdp';
import {
  call,
  countExpression,
  evaluate,
  evaluateScoped,
  type Handle,
  remoteValue,
  resolve,
  resolveWait,
  UserError,
} from '../dom';
import { type Annotation, annotations, drawAnnotations, formatAnnotations } from '../annotate';
import {
  captureKey,
  changedRatio,
  comparisonSize,
  formatPercent,
  getCapture,
  type Pixels,
  setCapture,
  setDiffBaseline,
} from '../capture-compare';
import { base64Blob } from '../base64';
import { frameBox } from '../frames';
import { splitScreenshotArgs } from '../screenshot-args';
import { snapshot } from '../snapshot';
import { computedStyles } from './extra';
import {
  computeDelta,
  formatDeltaText,
  formatUnchanged,
  getBaseline,
  nextRevision,
  setBaseline,
  setLastSnapshot,
  snapshotKey,
} from '../snapshot-diff';
import { session, state } from '../state';
import { sleep } from '../tabs';
import { prime } from '../input';

async function element(ctx: Ctx, target: string): Promise<Handle> {
  return resolveWait(await ctx.tab(), target, ctx.timeout, ctx.signal);
}

const VISIBLE = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && el.checkVisibility({ visibilityProperty: true });
}`;

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '.';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function urlMatches(url: string, pattern: string): boolean {
  return /[*?]/.test(pattern) ? globToRegExp(pattern).test(url) : url.includes(pattern);
}

/** How often `wait` forces a frame on a hidden tab (see `poll`). */
const FRAME_EVERY_MS = 500;

/**
 * `networkidle`: the document has loaded and no resource finished loading for 500 ms. This counts
 * resource-timing entries (no `Network.enable`), so it is blind to a request still in flight (a
 * long poll, an event stream counts as idle) and to anything the page does not report there.
 * The page's buffer holds 250 entries by default and then drops new ones, which would look idle
 * forever: the first poll raises the limit and clears the entries, so only what finishes during
 * the wait is counted (`performance.getEntriesByType('resource')` of the page is emptied once).
 */
export async function waitNetworkIdle(ctx: Ctx, id: number): Promise<void> {
  let last = -1;
  let primed = false;
  let since = Date.now();
  await poll(ctx, 'network idle', async () => {
    if ((await evaluate(id, 'document.readyState')).value !== 'complete') return false;
    if (!primed) {
      await evaluate(
        id,
        'performance.setResourceTimingBufferSize(100000), performance.clearResourceTimings()',
      );
      primed = true;
    }
    const n = (await evaluate(id, "performance.getEntriesByType('resource').length")).value;
    if (n !== last) {
      last = n as number;
      since = Date.now();
    }
    return Date.now() - since >= 500;
  });
}

async function poll(ctx: Ctx, what: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ctx.timeout;
  let framed = Date.now();
  for (;;) {
    // A hidden tab renders no frames, so work the page does in requestAnimationFrame (hiding a
    // spinner, showing results) never runs. Force a frame now and then while waiting.
    if (ctx.tabId !== undefined && Date.now() - framed >= FRAME_EVERY_MS) {
      framed = Date.now();
      await prime(ctx.tabId).catch(() => false);
    }
    try {
      if (await check()) return;
    } catch {
      // page navigating, element missing, … keep polling
    }
    if (ctx.signal.aborted) throw new UserError('cancelled');
    if (Date.now() > deadline)
      throw new UserError(`Timed out after ${ctx.timeout}ms waiting for ${what}`, 'timeout');
    await sleep(100);
  }
}

/**
 * Whether the text is on the page or in any of its iframes (the snapshot inlines them too).
 * Same-origin frames are searched from their parent's script; each out-of-process iframe through
 * its own session. A failing child session (navigating, gone) is skipped.
 */
async function pageHasText(tabId: number, text: string): Promise<boolean> {
  const expression = `(function has(w, t) {
    try {
      if (w.document.body?.innerText.includes(t)) return true;
    } catch { return false; } // cross-origin: its own session covers it, if any
    for (let i = 0; i < w.frames.length; i++) if (has(w.frames[i], t)) return true;
    return false;
  })(window, ${JSON.stringify(text)})`;
  if ((await evaluate(tabId, expression)).value === true) return true;
  for (const c of cdp.childSessions(tabId)) {
    try {
      const r = await cdp.send<{ result: { value?: unknown } }>(
        tabId,
        'Runtime.evaluate',
        { expression, returnByValue: true },
        c.sessionId,
      );
      if (r.result.value === true) return true;
    } catch {
      // the iframe navigated or went away
    }
  }
  return false;
}

function formatValue(value: unknown, token?: string): string {
  if (token !== undefined) return token;
  return typeof value === 'object' && value !== null
    ? JSON.stringify(value, null, 2)
    : JSON.stringify(value);
}

function decodeBase64(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

export const inspectionCommands: Command[] = [
  {
    name: 'snapshot',
    details:
      'Prints the accessibility tree; interactive elements get @refs you can pass to click, fill, get and so on. Refs stay stable across snapshots while the element lives; a new snapshot of a changed page shows what changed with --delta. Re-snapshot after navigation: refs of an old document are gone.',
    examples: ['bvl snapshot -i', 'bvl snapshot -i --delta', 'bvl snapshot -s main -d 3'],
    show: Infinity,
    showFlags: ['depth', 'selector'],
    group: 'Reading',
    usage: 'snapshot [-i] [-c] [-d N] [-s <selector>] [-u] [--delta] [--full] [@ref]',
    summary: 'Accessibility tree with @refs for interaction',
    flags: [
      {
        name: 'interactive',
        short: 'i',
        type: 'bool',
        desc: 'Interactive elements only (recommended)',
      },
      { name: 'compact', short: 'c', type: 'bool', desc: 'Drop empty structural nodes' },
      { name: 'depth', short: 'd', type: 'string', desc: 'Limit tree depth' },
      { name: 'selector', short: 's', type: 'string', desc: 'Scope to an element (CSS or @ref)' },
      { name: 'urls', short: 'u', type: 'bool', desc: 'Include link URLs' },
      {
        name: 'delta',
        type: 'bool',
        desc: 'Full tree once, then `unchanged` or only what changed since the last --delta',
      },
      { name: 'full', type: 'bool', desc: 'Full tree; with --delta also resets the baseline' },
    ],
    async run(ctx, a) {
      const id = await ctx.tab();
      const t = await chrome.tabs.get(id);
      const opts = {
        interactive: a.has('interactive'),
        compact: a.has('compact'),
        depth: a.num('depth'),
        scope: a.str('selector') ?? a.pos[0],
        urls: a.has('urls'),
      };
      const snap = await snapshot(id, { ...opts, session: ctx.session });
      const key = snapshotKey(id, opts, state.frames[id]?.frameId);
      setLastSnapshot(key, snap.text);
      const full = {
        text: snap.text,
        data: {
          origin: t.url,
          title: t.title,
          refs: snap.refs,
          removedRefs: snap.removedRefs,
          snapshot: snap.text,
        },
      };
      if (!a.has('delta') && !a.has('full')) return full;

      // Baseline per tab and option set; `--full` returns the tree and resets it.
      const now = {
        lines: snap.text.split('\n'),
        refs: snap.refs,
        url: t.url ?? '',
        doc: state.refDocs[id],
      };
      const base = getBaseline(key);
      const revision = nextRevision(id);
      const result =
        base && !a.has('full') && a.has('delta') ? computeDelta(base, now, revision) : undefined;
      setBaseline(key, { ...now, revision });
      if (result?.kind === 'unchanged') {
        return { text: formatUnchanged(result), data: { origin: t.url, snapshot: result } };
      }
      if (result)
        return {
          text: formatDeltaText(result, base?.lines ?? []),
          data: { origin: t.url, snapshot: result },
        };
      return {
        text: snap.text,
        data: {
          origin: t.url,
          snapshot: { kind: 'full', refs: snap.refs, revision, tree: snap.text },
        },
      };
    },
  },
  {
    name: 'get',
    details:
      'Reads one value from the page: text, html, value, attr, title, url, count, box or styles. `get attr` prints `null` for a missing attribute. `get styles` is curated by default; name properties or use --all for everything.',
    examples: [
      'bvl get title',
      'bvl get text @e2',
      'bvl get attr @e4 href',
      'bvl get count "li.item"',
    ],
    show: Infinity,
    group: 'Reading',
    usage: 'get <text|html|value|attr|title|url|count|box|styles> [target] [attr-name|css-prop…]',
    summary: 'Read text, HTML, values, attributes, title, URL, counts, boxes or styles',
    flags: [{ name: 'all', type: 'bool', desc: '`get styles`: every computed property' }],
    async run(ctx, a) {
      const what = a.need(0, 'text|html|value|attr|title|url|count|box|styles');
      const id = await ctx.tab();
      const origin = async () => (await chrome.tabs.get(id)).url ?? null;
      const out = async (value: unknown, data?: Record<string, unknown>) => ({
        text:
          typeof value === 'string'
            ? value === '' && ['text', 'html', 'value', 'attr', 'title'].includes(what)
              ? '(empty)'
              : value
            : JSON.stringify(value),
        data: data ?? { [what]: value, origin: await origin() },
      });
      switch (what) {
        case 'title': {
          const title = (await chrome.tabs.get(id)).title ?? '';
          return out(title, { title });
        }
        case 'url': {
          const url = (await chrome.tabs.get(id)).url ?? '';
          return out(url, { url });
        }
        case 'count': {
          const sel = a.need(1, 'selector');
          const r = await evaluateScoped(id, countExpression(sel));
          if (typeof r.value !== 'number') {
            throw new UserError(`Could not count ${sel}: the page returned no number`);
          }
          return out(r.value, { count: r.value, selector: sel });
        }
        case 'text':
        case 'html': {
          const target = a.pos[1];
          const h = target
            ? await element(ctx, target)
            : await resolve(id, what === 'text' ? 'body' : 'html');
          const fn =
            what === 'text'
              ? 'function () { return this.innerText ?? this.textContent; }'
              : 'function () { return this.innerHTML; }';
          return out(await call<string>(h, fn));
        }
        case 'value': {
          const value = await call(
            await element(ctx, a.need(1, 'target')),
            'function () { return this.value; }',
          );
          return out(value, { value, origin: await origin() });
        }
        case 'attr': {
          const h = await element(ctx, a.need(1, 'target'));
          const name = a.need(2, 'attribute name');
          const value = await call(h, 'function (n) { return this.getAttribute(n); }', [name]);
          return out(value, { value, attr: name, origin: await origin() });
        }
        case 'box': {
          const h = await element(ctx, a.need(1, 'target'));
          const box = await call<Record<string, number>>(
            h,
            `function () { const r = this.getBoundingClientRect();
                 return { x: r.x, y: r.y, width: r.width, height: r.height }; }`,
          );
          return out(box, { ...box, box });
        }
        case 'styles': {
          const h = await element(ctx, a.need(1, 'target'));
          const styles = await computedStyles(h, a.pos.slice(2), a.has('all'));
          return {
            text: Object.entries(styles)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n'),
            data: { styles, origin: await origin() },
          };
        }
        default:
          throw new UserError(`Unknown: get ${what}`, 'bad_args');
      }
    },
  },
  {
    name: 'is',
    show: Infinity,
    group: 'Reading',
    usage: 'is <visible|enabled|checked> <target>',
    summary: 'Check element state (prints true/false)',
    async run(ctx, a) {
      const what = a.need(0, 'visible|enabled|checked');
      const h = await element(ctx, a.need(1, 'target'));
      const fns: Record<string, string> = {
        visible: VISIBLE,
        enabled: `function () { return !this.disabled && this.getAttribute('aria-disabled') !== 'true'; }`,
        checked: `function () { return this.checked ?? this.getAttribute('aria-checked') === 'true'; }`,
      };
      const fn = fns[what];
      if (!fn) throw new UserError(`Unknown: is ${what}`, 'bad_args');
      const value = await call<boolean>(h, fn);
      return {
        text: String(value),
        data: { [what]: value, origin: (await chrome.tabs.get(h.tabId)).url ?? null },
      };
    },
  },
  {
    name: 'wait',
    details:
      'Polls until the condition holds or the timeout (--timeout, default 25000 ms) passes. `--text` prints the text it found and `--url` prints the URL it matched; the other waits print `\u2713 Done`. Wait for something to disappear with `--state hidden|detached`. Fails with code `timeout` when the condition never holds.',
    examples: [
      'bvl wait @e3',
      'bvl wait 1000',
      'bvl wait --text "Welcome back"',
      'bvl wait --url "**/dashboard"',
      'bvl wait "#spinner" --state hidden',
    ],
    show: Infinity,
    showFlags: ['text', 'url', 'load', 'state'],
    group: 'Waiting',
    usage:
      'wait <target|ms> [--state visible|hidden|attached|detached] | --text <t> | --url <glob> | --load <state> | --fn <js>',
    summary: 'Wait for an element, text, URL, load state or JS condition',
    flags: [
      { name: 'text', short: 't', type: 'string', desc: 'Text appears on the page' },
      { name: 'url', short: 'u', type: 'string', desc: 'URL matches a glob (e.g. **/dashboard)' },
      { name: 'load', short: 'l', type: 'string', desc: 'load | domcontentloaded | networkidle' },
      { name: 'fn', short: 'f', type: 'string', desc: 'JavaScript condition becomes truthy' },
      { name: 'state', type: 'string', desc: 'Element state (default visible)' },
    ],
    async run(ctx, a) {
      const first = a.pos[0];
      if (first !== undefined && /^\d+$/.test(first)) {
        await sleep(Number(first));
        return { text: '✓ Done', data: { ms: Number(first), waited: 'timeout' } };
      }
      const id = await ctx.tab();
      const text = a.str('text');
      const url = a.str('url');
      const load = a.str('load');
      const fn = a.str('fn');
      let result: Result = { text: '✓ Done' };
      if (first !== undefined) {
        const st = a.str('state') ?? 'visible';
        const visible = async () => call<boolean>(await resolve(id, first), VISIBLE);
        const exists = async () =>
          resolve(id, first).then(
            () => true,
            () => false,
          );
        const checks: Record<string, () => Promise<boolean>> = {
          visible,
          hidden: async () => !(await exists()) || !(await visible()),
          attached: exists,
          detached: async () => !(await exists()),
        };
        const check = checks[st];
        if (!check)
          throw new UserError('--state must be visible|hidden|attached|detached', 'bad_args');
        await poll(ctx, `${first} to be ${st}`, check);
      } else if (text !== undefined) {
        await poll(ctx, `text "${text}"`, () => pageHasText(id, text));
        result = { text, data: { text } };
      } else if (url !== undefined) {
        let matched = '';
        await poll(ctx, `URL ${url}`, async () => {
          matched = (await chrome.tabs.get(id)).url ?? '';
          return urlMatches(matched, url);
        });
        result = { text: matched, data: { url: matched } };
      } else if (fn !== undefined) {
        await poll(ctx, `condition ${fn}`, async () =>
          Boolean((await evaluateScoped(id, fn)).value),
        );
      } else if (load !== undefined) {
        const ready = async (want: string) =>
          (await evaluate(id, 'document.readyState')).value === want;
        if (load === 'domcontentloaded') {
          await poll(ctx, 'DOMContentLoaded', async () => !(await ready('loading')));
        } else if (load === 'load') {
          await poll(ctx, 'load', () => ready('complete'));
        } else if (load === 'networkidle') {
          await waitNetworkIdle(ctx, id);
        } else throw new UserError('--load must be load|domcontentloaded|networkidle', 'bad_args');
      } else {
        throw new UserError('Usage: wait <target|ms> | --text | --url | --load | --fn', 'bad_args');
      }
      return result;
    },
  },
  {
    name: 'screenshot',
    details:
      'Saves a PNG of the visible page, or the whole scrollable page with --full. With a ref, CSS selector or XPath it captures just that element (not with --full; on a shared tab the page is scrolled only if the element is not already in view). A single argument is the target unless it starts with / ./ ../, contains a / (without selector characters) or ends in .png/.jpg/.jpeg/.webp, then it is the path; with two, the target comes first. The format is JPEG when the path ends in .jpg/.jpeg, else --screenshot-format (png default); --screenshot-quality 0-100 applies to JPEG. Without a path it writes to a temp file (or --screenshot-dir) and prints the path.',
    examples: [
      'bvl screenshot',
      'bvl screenshot page.png --full',
      'bvl screenshot @e3 card.png',
      'bvl screenshot "#chart" chart.png',
      'bvl screenshot --screenshot-format jpeg --screenshot-quality 60',
    ],
    show: Infinity,
    group: 'Reading',
    showFlags: ['threshold'],
    usage:
      'screenshot [target] [path] [--full] [--annotate] [--if-changed] [--threshold <0-1>] [--screenshot-format png|jpeg] [--screenshot-quality <0-100>] [--screenshot-dir <dir>]',
    summary:
      'Save a PNG or JPEG screenshot (--screenshot-format); without a path it goes to a temp file',
    flags: [
      { name: 'full', type: 'bool', desc: 'Capture the full scrollable page' },
      {
        name: 'annotate',
        type: 'bool',
        desc: 'Draw numbered boxes for the interactive elements ([N] = @eN) and list them',
      },
      {
        name: 'if-changed',
        type: 'bool',
        desc: 'Skip the file when the page looks the same as the last such capture',
      },
      {
        name: 'threshold',
        type: 'string',
        desc: 'Ignore changes up to this fraction of pixels (0-1); implies --if-changed',
      },
    ],
    async run(ctx, a) {
      const full = a.has('full');
      const annotate = a.has('annotate');
      const thresholdArg = a.str('threshold');
      const conditional = a.has('if-changed') || thresholdArg !== undefined;
      const threshold = a.num('threshold') ?? 0;
      if (a.has('threshold') && thresholdArg === undefined)
        throw new UserError('Missing --threshold value', 'bad_args');
      if (threshold < 0 || threshold > 1) {
        throw new UserError(
          `--threshold must be from 0 to 1, got '${thresholdArg ?? ''}'`,
          'bad_args',
        );
      }
      const formatArg = a.str('screenshot-format');
      const wanted = formatArg?.toLowerCase();
      if (a.has('screenshot-format') && wanted !== 'png' && wanted !== 'jpeg') {
        throw new UserError(
          `--screenshot-format must be png or jpeg, got '${formatArg ?? ''}'`,
          'bad_args',
        );
      }
      const qualityArg = a.str('screenshot-quality');
      let quality: number | undefined;
      if (a.has('screenshot-quality')) {
        quality = /^\d+$/.test(qualityArg ?? '') ? Number(qualityArg) : NaN;
        if (!(quality >= 0 && quality <= 100)) {
          throw new UserError(
            `--screenshot-quality must be an integer from 0 to 100, got '${qualityArg ?? ''}'`,
            'bad_args',
          );
        }
      }
      const dirArg = a.str('screenshot-dir');
      if (a.has('screenshot-dir') && !dirArg)
        throw new UserError('--screenshot-dir needs a directory', 'bad_args');
      const { target, path: pathArg } = splitScreenshotArgs(a.pos);
      if (target !== undefined && full) {
        throw new UserError('--full cannot be combined with an element target', 'bad_args');
      }
      const id = await ctx.tab();
      // An explicit path extension wins over --screenshot-format; png is the default.
      const explicit = pathArg ? ctx.path(pathArg) : undefined;
      const flagFormat: Format = wanted === 'jpeg' ? 'jpeg' : 'png';
      const extFormat: Format | undefined = !explicit
        ? undefined
        : /\.jpe?g$/i.test(explicit)
          ? 'jpeg'
          : /\.png$/i.test(explicit)
            ? 'png'
            : undefined;
      const format: Format = extFormat ?? flagFormat;
      const warnings: string[] = [];
      if (wanted !== undefined && extFormat && extFormat !== flagFormat) {
        warnings.push(
          `--screenshot-format ${wanted} ignored: path ends in .${extFormat === 'jpeg' ? 'jpg/.jpeg' : 'png'}`,
        );
      }
      if (dirArg && explicit) warnings.push('--screenshot-dir ignored: a path was given');
      const fileName = `screenshot-${Date.now()}.${format === 'jpeg' ? 'jpg' : 'png'}`;
      const path =
        explicit ??
        (dirArg
          ? joinPath(ctx.path(dirArg), fileName, ctx.req.sep)
          : ctx.tmpPath('bvl', 'screenshots', fileName));
      if (quality !== undefined && format === 'png')
        warnings.push('--screenshot-quality only applies to jpeg; ignored');
      const q = format === 'jpeg' ? (quality ?? DEFAULT_JPEG_QUALITY) : undefined;
      const enc: Encoding = { format, quality: q };
      // With --annotate the capture is only an intermediate: lossless, encoded once at the end.
      const capEnc: Encoding = annotate ? { format: 'png', quality: undefined } : enc;

      // Always the plain capture first; the comparison ignores annotations.
      let data: string;
      let truncated = false;
      let el: ElementShot | undefined;
      let matchWarning: string | undefined;
      if (target !== undefined) {
        const h = await element(ctx, target);
        if (h.matches !== undefined && h.matches > 1) {
          matchWarning = `${String(h.matches)} elements match "${target}"; used the first. Use a @ref or a more specific selector.`;
        }
        el = await elementShot(h, capEnc);
        ({ data, truncated } = el);
      } else {
        if (full) ({ data, truncated } = await fullPage(id, capEnc));
        else ({ data } = await viewport(id, capEnc));
        // The plain capture is also the reference for a later `diff screenshot`. Only PNG is kept
        // (JPEG noise would show up as changes), so a JPEG capture (from a .jpg path or
        // --screenshot-format jpeg) takes a PNG one as well. An element capture is not a
        // baseline: it would replace the viewport/full one with a differently sized picture.
        const png: Encoding = { format: 'png', quality: undefined };
        setDiffBaseline(
          captureKey(id, full ? 'diff:full' : 'diff:view'),
          capEnc.format === 'png'
            ? data
            : (await (full ? fullPage(id, png) : viewport(id, png))).data,
          truncated,
        );
      }

      const extra: Record<string, unknown> = {};
      if (conditional) {
        const key = captureKey(
          id,
          `${
            target !== undefined
              ? `el:${annotate ? 'annotate' : 'plain'}:${target}`
              : `${full ? 'full' : 'view'}${annotate ? '+annotate' : ''}`
          }:${format}${q !== undefined ? String(q) : ''}`,
        );
        const prev = getCapture(key);
        const pixels = await comparisonPixels(data, capEnc.format);
        const ratio = prev ? changedRatio(prev.pixels, pixels) : 1;
        const revision = (prev?.revision ?? 0) + 1;
        if (prev && ratio <= threshold) {
          // Keep the older picture as the reference so slow drift still adds up.
          setCapture(key, { pixels: prev.pixels, revision });
          return {
            text: `✓ Screenshot unchanged (revision ${String(revision)}, ${formatPercent(ratio)} pixels changed)`,
            data: {
              changed: false,
              pixelChangeRatio: ratio,
              revision,
              threshold,
              ...(el ? { selector: target, box: el.box } : {}),
            },
          };
        }
        setCapture(key, { pixels, revision });
        Object.assign(extra, { changed: true, pixelChangeRatio: ratio, revision, threshold });
      }

      let list: Annotation[] | undefined;
      if (annotate) {
        const m = await cdp.send<{
          cssVisualViewport: {
            clientWidth: number;
            clientHeight: number;
            pageX: number;
            pageY: number;
          };
          cssContentSize: { width: number };
        }>(id, 'Page.getLayoutMetrics');
        const v = m.cssVisualViewport;
        // An element capture: page-coordinate boxes of the refs inside it, moved to the clip origin.
        const wantPage = full || el !== undefined;
        list = await annotations(id, ctx.session, {
          width: v.clientWidth,
          height: v.clientHeight,
          offsetX: wantPage ? v.pageX : 0,
          offsetY: wantPage ? v.pageY : 0,
          full: wantPage,
        });
        if (el) list = insideBox(list, el.box);
        const drawn = await drawAnnotations(
          await base64Blob(data, 'image/png'),
          list,
          el ? el.box.width : full ? m.cssContentSize.width : v.clientWidth,
          format,
          q,
        );
        data = toBase64(new Uint8Array(await drawn.arrayBuffer()));
      }

      ctx.files.push({ path, base64: data });
      const listing = list?.length ? `\n${formatAnnotations(list)}` : '';
      return {
        text: `✓ Screenshot saved to ${path}${listing}`,
        data: {
          path,
          ...(el ? { selector: target, box: el.box, truncated } : {}),
          ...(full ? { truncated } : {}),
          ...(list ? { annotations: list } : {}),
          ...extra,
        },
        warning: [
          ...(matchWarning ? [matchWarning] : []),
          ...(truncated
            ? [
                el
                  ? `Very large element: the screenshot shows only its top-left ${String(el.box.width)}x${String(el.box.height)} px`
                  : 'Very tall page: the full-page screenshot was truncated',
              ]
            : []),
          ...warnings,
        ],
      };
    },
  },
  {
    name: 'eval',
    details:
      'Runs JavaScript in the page and prints the result as JSON (promises are awaited). Use -b <base64> or --stdin for scripts with awkward quoting.',
    examples: [
      'bvl eval document.title',
      'bvl eval "[...document.links].length"',
      "echo 'document.body.innerText.length' | bvl eval --stdin",
    ],
    log(a, req) {
      // Never log the script; its size is enough to tell commands apart.
      let n = a.pos.join(' ').length;
      if (a.has('stdin')) n = (req.stdin ?? '').length;
      else if (a.str('base64') !== undefined) {
        try {
          n = decodeBase64(a.str('base64') ?? '').length;
        } catch {
          n = 0;
        }
      }
      return [`(${n} chars)`];
    },
    group: 'Reading',
    usage: 'eval <js> | eval -b <base64> | eval --stdin',
    summary: 'Run JavaScript in the page (awaits promises) and print the result',
    flags: [
      { name: 'base64', short: 'b', type: 'string', desc: 'Script as base64' },
      { name: 'stdin', type: 'bool', desc: 'Read the script from stdin' },
    ],
    async run(ctx, a) {
      const b64 = a.str('base64');
      const script = a.has('stdin')
        ? (ctx.req.stdin ?? '')
        : b64 !== undefined
          ? decodeBase64(b64)
          : a.pos.join(' ');
      if (!script.trim())
        throw new UserError('Usage: eval <js> | eval -b <base64> | eval --stdin', 'bad_args');
      const id = await ctx.tab();
      const { value, token } = remoteValue(await evaluateScoped(id, script));
      const origin = (await chrome.tabs.get(id)).url ?? null;
      return {
        text: formatValue(value, token),
        data:
          token === undefined
            ? { result: value, origin }
            : { result: null, unserializable: token, origin },
      };
    },
  },
  {
    name: 'dialog',
    details:
      'Confirm and prompt dialogs block the page until answered. `status` reports whether one is open; `accept [text]` and `dismiss` answer it. Alerts and beforeunload dialogs are accepted automatically.',
    examples: ['bvl dialog status', 'bvl dialog accept', 'bvl dialog dismiss'],
    group: 'Waiting',
    usage: 'dialog <status|accept [text]|dismiss>',
    summary: 'Handle confirm/prompt dialogs (alerts are accepted automatically)',
    async run(ctx, a) {
      const sub = a.pos[0] ?? 'status';
      const id = ctx.tabId ?? (await currentTabIgnoringDialog(ctx));
      const dialog = cdp.tabEvents(id).dialog;
      if (sub === 'status') {
        return dialog
          ? {
              text: `${dialog.type}: ${dialog.message}`,
              data: { hasDialog: true, open: true, ...dialog },
            }
          : { text: '✓ No dialog is currently open', data: { hasDialog: false, open: false } };
      }
      if (!dialog) throw new UserError('No dialog is open', 'not_found');
      if (sub !== 'accept' && sub !== 'dismiss')
        throw new UserError('Usage: dialog <status|accept|dismiss>', 'bad_args');
      await cdp.send(id, 'Page.handleJavaScriptDialog', {
        accept: sub === 'accept',
        promptText: a.pos[1] ?? dialog.defaultPrompt ?? '',
      });
      delete cdp.tabEvents(id).dialog;
      return { text: '✓ Done' };
    },
  },
  {
    name: 'console',
    group: 'Debugging',
    usage: 'console [--clear]',
    summary: 'Console messages since the agent attached to the tab',
    flags: [{ name: 'clear', type: 'bool', desc: 'Clear after printing' }],
    async run(ctx, a) {
      const ev = cdp.tabEvents(await ctx.tab());
      const entries = [...ev.console];
      if (a.has('clear')) ev.console.length = 0;
      return {
        text: entries.map((m) => `[${m.type}] ${m.text}`).join('\n'),
        data: { messages: entries },
      };
    },
  },
  {
    name: 'errors',
    group: 'Debugging',
    usage: 'errors [--clear]',
    summary: 'Uncaught page errors since the agent attached to the tab',
    flags: [{ name: 'clear', type: 'bool', desc: 'Clear after printing' }],
    async run(ctx, a) {
      const ev = cdp.tabEvents(await ctx.tab());
      const entries = [...ev.errors];
      if (a.has('clear')) ev.errors.length = 0;
      return { text: entries.map((e) => e.text).join('\n\n'), data: { errors: entries } };
    },
  },
];

// Chrome can't capture more than ~16k px in one go; canvases top out around 32k px.
const SLICE = 8000;
const MAX_HEIGHT = 32000;

type Format = 'png' | 'jpeg';
/** JPEG quality when none is given, used for every encoder so all paths agree. */
const DEFAULT_JPEG_QUALITY = 80;
interface Encoding {
  format: Format;
  /** JPEG quality 0-100; undefined for png. */
  quality: number | undefined;
}

function joinPath(dir: string, name: string, sep: string): string {
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + sep + name;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/**
 * `Page.captureScreenshot` on a hidden tab sometimes never answers (see `prime`); a later attempt
 * works once a frame exists, so retry a few times instead of hanging.
 */
async function captureScreenshot(
  tabId: number,
  params: Record<string, unknown>,
): Promise<{ data: string }> {
  for (let attempt = 0; ; attempt++) {
    const pending = cdp.send<{ data: string }>(tabId, 'Page.captureScreenshot', params);
    if (attempt >= 3) return pending;
    pending.catch(() => undefined);
    const r = await Promise.race([pending, sleep(4000).then(() => undefined)]);
    if (r) return r;
  }
}

/**
 * Screenshot of the visible viewport. A hidden (background) tab has no surface of its own to copy,
 * and a plain capture of it has been seen to return another tab's picture. For a hidden tab,
 * capture the viewport's area of the page the way `--full` does (`captureBeyondViewport`), which
 * renders this tab's own frame.
 */
export async function viewport(tabId: number, enc: Encoding): Promise<{ data: string }> {
  const { format, quality } = enc;
  const fmt = { format, ...(quality !== undefined ? { quality } : {}) };
  const hidden = (await evaluate(tabId, 'document.visibilityState')).value === 'hidden';
  if (!hidden) return captureScreenshot(tabId, fmt);
  const { cssVisualViewport: v } = await cdp.send<{
    cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
  }>(tabId, 'Page.getLayoutMetrics');
  return captureScreenshot(tabId, {
    ...fmt,
    captureBeyondViewport: true,
    clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale: 1 },
  });
}

interface ElementShot {
  data: string;
  truncated: boolean;
  /** The captured area in CSS px, page coordinates. */
  box: Annotation['box'];
}

/**
 * Screenshot of one element: measure its content quads (shifted by the iframe's box for an
 * out-of-process iframe, as `annotations` does) and capture that area of the page.
 *
 * A visible tab whose element already lies inside the viewport is captured with a plain clip: no
 * scrolling and no `captureBeyondViewport`, which resizes the viewport for the capture (fires
 * `resize`, relayouts, can misplace `position: fixed` elements). Otherwise the element is
 * scrolled into view first (this moves the user's scroll on a shared tab), and the capture uses
 * `captureBeyondViewport` when the tab is hidden (the path hidden tabs use for the viewport) or
 * the element does not fit in the viewport.
 */
async function elementShot(h: Handle, enc: Encoding): Promise<ElementShot> {
  const hidden = (await evaluate(h.tabId, 'document.visibilityState')).value === 'hidden';
  const measure = async () => {
    let quads: number[][] = [];
    try {
      ({ quads } = await cdp.send<{ quads: number[][] }>(
        h.tabId,
        'DOM.getContentQuads',
        { objectId: h.objectId },
        h.sessionId,
      ));
    } catch {
      // no box
    }
    const xs = quads.flatMap((q) => q.filter((_, i) => i % 2 === 0));
    const ys = quads.flatMap((q) => q.filter((_, i) => i % 2 === 1));
    if (xs.length === 0) throw new UserError('Element is not visible', 'not_visible');
    let left = Math.min(...xs);
    let top = Math.min(...ys);
    let right = Math.max(...xs);
    let bottom = Math.max(...ys);
    if (h.sessionId) {
      const f = await frameBox(h.tabId, h.sessionId);
      left += f.x;
      right += f.x;
      top += f.y;
      bottom += f.y;
      // Only what the iframe shows. (An element of a same-process iframe is not clipped.)
      left = Math.max(left, f.x);
      top = Math.max(top, f.y);
      right = Math.min(right, f.x + f.width);
      bottom = Math.min(bottom, f.y + f.height);
    }
    return { left, top, right, bottom };
  };
  const metrics = async () =>
    (
      await cdp.send<{
        cssVisualViewport: {
          pageX: number;
          pageY: number;
          clientWidth: number;
          clientHeight: number;
        };
      }>(h.tabId, 'Page.getLayoutMetrics')
    ).cssVisualViewport;
  const fits = (
    b: { left: number; top: number; right: number; bottom: number },
    v: Awaited<ReturnType<typeof metrics>>,
  ) => b.left >= 0 && b.top >= 0 && b.right <= v.clientWidth && b.bottom <= v.clientHeight;

  let b = await measure();
  let v = await metrics();
  if (hidden || !fits(b, v)) {
    try {
      await cdp.send(h.tabId, 'DOM.scrollIntoViewIfNeeded', { objectId: h.objectId }, h.sessionId);
    } catch {
      // not rendered; the measurement says so
    }
    b = await measure();
    v = await metrics();
  }
  const dpr = Number((await evaluate(h.tabId, 'devicePixelRatio')).value) || 1;
  const limit = Math.floor(MAX_HEIGHT / dpr);
  const x = Math.max(0, Math.floor(b.left + v.pageX));
  const y = Math.max(0, Math.floor(b.top + v.pageY));
  const fullWidth = Math.ceil(b.right + v.pageX) - x;
  const fullHeight = Math.ceil(b.bottom + v.pageY) - y;
  if (!(fullWidth >= 1) || !(fullHeight >= 1)) {
    throw new UserError('Element is not visible', 'not_visible');
  }
  const width = Math.min(fullWidth, limit);
  const height = Math.min(fullHeight, SLICE, limit);
  const plain = !hidden && fits(b, v);
  const { data } = await captureScreenshot(h.tabId, {
    format: enc.format,
    ...(enc.quality !== undefined ? { quality: enc.quality } : {}),
    ...(plain ? {} : { captureBeyondViewport: true }),
    clip: { x, y, width, height, scale: 1 },
  });
  return {
    data,
    truncated: fullWidth > width || fullHeight > height,
    box: { x, y, width, height },
  };
}

/** Annotations whose centre lies in `box` (page coordinates), moved to the box's origin. */
function insideBox(list: Annotation[], box: Annotation['box']): Annotation[] {
  return list
    .filter((a) => {
      const cx = a.box.x + a.box.width / 2;
      const cy = a.box.y + a.box.height / 2;
      return cx >= box.x && cx <= box.x + box.width && cy >= box.y && cy <= box.y + box.height;
    })
    .map((a) => ({ ...a, box: { ...a.box, x: a.box.x - box.x, y: a.box.y - box.y } }));
}

/** The capture decoded and downscaled for comparison. */
async function comparisonPixels(base64: string, format: 'png' | 'jpeg'): Promise<Pixels> {
  const bmp = await createImageBitmap(await base64Blob(base64, `image/${format}`));
  const size = comparisonSize(bmp.width, bmp.height);
  const canvas = new OffscreenCanvas(size.width, size.height);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('Canvas unavailable');
  g.drawImage(bmp, 0, 0, size.width, size.height);
  return { ...size, data: g.getImageData(0, 0, size.width, size.height).data };
}

/** Full-page screenshot; tall pages are captured in slices and stitched together. */
export async function fullPage(
  tabId: number,
  enc: Encoding,
): Promise<{ data: string; truncated: boolean }> {
  const { format, quality } = enc;
  const m = await cdp.send<{ cssContentSize: { width: number; height: number } }>(
    tabId,
    'Page.getLayoutMetrics',
  );
  // Captures come back in device pixels; keep the stitched canvas within limits in those units.
  const dpr = Number((await evaluate(tabId, 'devicePixelRatio')).value) || 1;
  const width = Math.ceil(m.cssContentSize.width);
  const fullHeight = Math.ceil(m.cssContentSize.height);
  const height = Math.min(fullHeight, Math.floor(MAX_HEIGHT / dpr));
  const capture = (y: number, h: number, single: boolean) =>
    captureScreenshot(tabId, {
      // Slices are stitched losslessly; a single capture is encoded as requested.
      format: single ? format : 'png',
      ...(single && quality !== undefined ? { quality } : {}),
      captureBeyondViewport: true,
      clip: { x: 0, y, width, height: h, scale: 1 },
    });

  if (height <= SLICE) {
    return { data: (await capture(0, height, true)).data, truncated: false };
  }
  const canvas = new OffscreenCanvas(Math.round(width * dpr), Math.round(height * dpr));
  const g = canvas.getContext('2d');
  if (!g) throw new Error('Canvas unavailable');
  for (let y = 0; y < height; y += SLICE) {
    const h = Math.min(SLICE, height - y);
    const { data } = await capture(y, h, false);
    g.drawImage(
      await createImageBitmap(await base64Blob(data, 'image/png')),
      0,
      Math.round(y * dpr),
    );
  }
  const out = await canvas.convertToBlob({
    type: `image/${format}`,
    ...(quality !== undefined ? { quality: quality / 100 } : {}),
  });
  return {
    data: toBase64(new Uint8Array(await out.arrayBuffer())),
    truncated: fullHeight > height,
  };
}

/** `dialog` must work while a dialog blocks the tab, so it bypasses ctx.tab()'s dialog check. */
async function currentTabIgnoringDialog(ctx: Ctx): Promise<number> {
  try {
    return await ctx.tab();
  } catch (e) {
    const id = session(ctx.session).tab;
    if (id !== undefined && cdp.tabEvents(id).dialog) return id;
    throw e;
  }
}
