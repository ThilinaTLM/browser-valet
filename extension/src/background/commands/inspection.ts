import { type Command, type Ctx } from '../command';
import * as cdp from '../cdp';
import {
  call,
  countExpression,
  evaluate,
  type Handle,
  remoteValue,
  resolve,
  resolveWait,
  UserError,
} from '../dom';
import { snapshot } from '../snapshot';
import { computedStyles } from './extra';
import { session } from '../state';
import { sleep } from '../tabs';

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

async function poll(ctx: Ctx, what: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ctx.timeout;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // page navigating, element missing, … keep polling
    }
    if (ctx.signal.aborted) throw new UserError('cancelled');
    if (Date.now() > deadline)
      throw new UserError(`Timed out after ${ctx.timeout}ms waiting for ${what}`);
    await sleep(100);
  }
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
    show: Infinity,
    showFlags: ['depth', 'selector'],
    group: 'Reading',
    usage: 'snapshot [-i] [-c] [-d N] [-s <selector>] [-u] [@ref]',
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
    ],
    async run(ctx, a) {
      const id = await ctx.tab();
      const t = await chrome.tabs.get(id);
      const snap = await snapshot(id, {
        interactive: a.has('interactive'),
        compact: a.has('compact'),
        depth: a.num('depth'),
        scope: a.str('selector') ?? a.pos[0],
        urls: a.has('urls'),
      });
      return {
        text: snap.text,
        data: { snapshot: snap.text, refs: snap.refs, origin: t.url, title: t.title },
      };
    },
  },
  {
    name: 'get',
    show: Infinity,
    group: 'Reading',
    usage: 'get <text|html|value|attr|title|url|count|box|styles> [target] [attr-name|css-prop…]',
    summary: 'Read text, HTML, values, attributes, title, URL, counts, boxes or styles',
    flags: [{ name: 'all', type: 'bool', desc: '`get styles`: every computed property' }],
    async run(ctx, a) {
      const what = a.need(0, 'text|html|value|attr|title|url|count|box|styles');
      const id = await ctx.tab();
      const out = (value: unknown) => ({
        text: typeof value === 'string' ? value : JSON.stringify(value),
        data: { [what]: value },
      });
      switch (what) {
        case 'title':
          return out((await chrome.tabs.get(id)).title ?? '');
        case 'url':
          return out((await chrome.tabs.get(id)).url ?? '');
        case 'count': {
          const sel = a.need(1, 'selector');
          const r = await evaluate(id, countExpression(sel));
          return out(r.value);
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
        case 'value':
          return out(
            await call(
              await element(ctx, a.need(1, 'target')),
              'function () { return this.value; }',
            ),
          );
        case 'attr': {
          const h = await element(ctx, a.need(1, 'target'));
          const name = a.need(2, 'attribute name');
          return out(await call(h, 'function (n) { return this.getAttribute(n); }', [name]));
        }
        case 'box': {
          const h = await element(ctx, a.need(1, 'target'));
          return out(
            await call(
              h,
              `function () { const r = this.getBoundingClientRect();
                 return { x: r.x, y: r.y, width: r.width, height: r.height }; }`,
            ),
          );
        }
        case 'styles': {
          const h = await element(ctx, a.need(1, 'target'));
          const styles = await computedStyles(h, a.pos.slice(2), a.has('all'));
          return {
            text: Object.entries(styles)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n'),
            data: { styles },
          };
        }
        default:
          throw new UserError(`Unknown: get ${what}`);
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
      if (!fn) throw new UserError(`Unknown: is ${what}`);
      const value = await call<boolean>(h, fn);
      return { text: String(value), data: { [what]: value } };
    },
  },
  {
    name: 'wait',
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
        return { text: '✓ Done' };
      }
      const id = await ctx.tab();
      const text = a.str('text');
      const url = a.str('url');
      const load = a.str('load');
      const fn = a.str('fn');
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
        if (!check) throw new UserError('--state must be visible|hidden|attached|detached');
        await poll(ctx, `${first} to be ${st}`, check);
      } else if (text !== undefined) {
        const expr = `document.body?.innerText.includes(${JSON.stringify(text)}) ?? false`;
        await poll(ctx, `text "${text}"`, async () => (await evaluate(id, expr)).value === true);
      } else if (url !== undefined) {
        await poll(ctx, `URL ${url}`, async () =>
          urlMatches((await chrome.tabs.get(id)).url ?? '', url),
        );
      } else if (fn !== undefined) {
        await poll(ctx, `condition ${fn}`, async () => Boolean((await evaluate(id, fn)).value));
      } else if (load !== undefined) {
        const ready = async (want: string) =>
          (await evaluate(id, 'document.readyState')).value === want;
        if (load === 'domcontentloaded') {
          await poll(ctx, 'DOMContentLoaded', async () => !(await ready('loading')));
        } else if (load === 'load') {
          await poll(ctx, 'load', () => ready('complete'));
        } else if (load === 'networkidle') {
          // No new resource requests for 500ms after load.
          let last = -1;
          let since = Date.now();
          await poll(ctx, 'network idle', async () => {
            if (!(await ready('complete'))) return false;
            const n = (await evaluate(id, "performance.getEntriesByType('resource').length")).value;
            if (n !== last) {
              last = n as number;
              since = Date.now();
            }
            return Date.now() - since >= 500;
          });
        } else throw new UserError('--load must be load|domcontentloaded|networkidle');
      } else {
        throw new UserError('Usage: wait <target|ms> | --text | --url | --load | --fn');
      }
      return { text: '✓ Done' };
    },
  },
  {
    name: 'screenshot',
    show: Infinity,
    group: 'Reading',
    usage: 'screenshot [path] [--full]',
    summary: 'Save a PNG (or .jpg) screenshot; without a path it goes to a temp file',
    flags: [{ name: 'full', type: 'bool', desc: 'Capture the full scrollable page' }],
    async run(ctx, a) {
      const id = await ctx.tab();
      const path = a.pos[0]
        ? ctx.path(a.pos[0])
        : ctx.tmpPath('bctl', 'screenshots', `screenshot-${Date.now()}.png`);
      const format = /\.jpe?g$/i.test(path) ? 'jpeg' : 'png';
      if (!a.has('full')) {
        const { data } = await cdp.send<{ data: string }>(id, 'Page.captureScreenshot', { format });
        ctx.files.push({ path, base64: data });
        return { text: `✓ Screenshot saved to ${path}`, data: { path } };
      }
      const { data, truncated } = await fullPage(id, format);
      ctx.files.push({ path, base64: data });
      const note = truncated ? ' (very tall page: truncated)' : '';
      return { text: `✓ Screenshot saved to ${path}${note}`, data: { path, truncated } };
    },
  },
  {
    name: 'eval',
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
      if (!script.trim()) throw new UserError('Usage: eval <js> | eval -b <base64> | eval --stdin');
      const { value, token } = remoteValue(await evaluate(await ctx.tab(), script));
      return {
        text: formatValue(value, token),
        data: token === undefined ? { result: value } : { result: null, unserializable: token },
      };
    },
  },
  {
    name: 'dialog',
    group: 'Waiting',
    usage: 'dialog <status|accept [text]|dismiss>',
    summary: 'Handle confirm/prompt dialogs (alerts are accepted automatically)',
    async run(ctx, a) {
      const sub = a.pos[0] ?? 'status';
      const id = ctx.tabId ?? (await currentTabIgnoringDialog(ctx));
      const dialog = cdp.tabEvents(id).dialog;
      if (sub === 'status') {
        return dialog
          ? { text: `${dialog.type}: ${dialog.message}`, data: { open: true, ...dialog } }
          : { text: '✓ No dialog is currently open', data: { open: false } };
      }
      if (!dialog) throw new UserError('No dialog is open');
      if (sub !== 'accept' && sub !== 'dismiss')
        throw new UserError('Usage: dialog <status|accept|dismiss>');
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
      const lines = [...ev.console];
      if (a.has('clear')) ev.console.length = 0;
      return { text: lines.join('\n'), data: { messages: lines } };
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
      const lines = [...ev.errors];
      if (a.has('clear')) ev.errors.length = 0;
      return { text: lines.join('\n\n'), data: { errors: lines } };
    },
  },
];

// Chrome can't capture more than ~16k px in one go; canvases top out around 32k px.
const SLICE = 8000;
const MAX_HEIGHT = 32000;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** Full-page screenshot; tall pages are captured in slices and stitched together. */
async function fullPage(
  tabId: number,
  format: 'png' | 'jpeg',
): Promise<{ data: string; truncated: boolean }> {
  const m = await cdp.send<{ cssContentSize: { width: number; height: number } }>(
    tabId,
    'Page.getLayoutMetrics',
  );
  // Captures come back in device pixels; keep the stitched canvas within limits in those units.
  const dpr = Number((await evaluate(tabId, 'devicePixelRatio')).value) || 1;
  const width = Math.ceil(m.cssContentSize.width);
  const fullHeight = Math.ceil(m.cssContentSize.height);
  const height = Math.min(fullHeight, Math.floor(MAX_HEIGHT / dpr));
  const capture = (y: number, h: number) =>
    cdp.send<{ data: string }>(tabId, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y, width, height: h, scale: 1 },
    });

  if (height <= SLICE && format === 'png') {
    return { data: (await capture(0, height)).data, truncated: false };
  }
  const canvas = new OffscreenCanvas(Math.round(width * dpr), Math.round(height * dpr));
  const g = canvas.getContext('2d');
  if (!g) throw new Error('Canvas unavailable');
  for (let y = 0; y < height; y += SLICE) {
    const h = Math.min(SLICE, height - y);
    const { data } = await capture(y, h);
    const blob = new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], {
      type: 'image/png',
    });
    g.drawImage(await createImageBitmap(blob), 0, Math.round(y * dpr));
  }
  const out = await canvas.convertToBlob({ type: `image/${format}` });
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
