import { type Command, type Ctx, type Result } from '../command';
import * as cdp from '../cdp';
import { evaluate, UserError } from '../dom';
import { findTab, meta, save, session, state } from '../state';
import { grant, isControlled, requestControl, revoke, sleep, waitForLoad } from '../tabs';

function normalizeUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url)) return `http://${url}`;
  return `https://${url}`;
}

async function pageResult(tabId: number): Promise<Result> {
  const t = await chrome.tabs.get(tabId);
  let { title = '', url = t.pendingUrl ?? '' } = t;
  // The tabs API can lag behind CDP load events; ask the page itself when we can.
  if (cdp.isAttached(tabId)) {
    const page = await evaluate(tabId, '({ title: document.title, url: location.href })').catch(
      () => undefined,
    );
    const v = page?.value as { title: string; url: string } | undefined;
    if (v) ({ title, url } = v);
  }
  const m = meta(tabId);
  return {
    text: `✓ ${title}\n  ${url}`,
    data: { tabId: m.tid, label: m.label, title, url },
  };
}

/** Wait for the main frame's load event (resolves false on timeout). */
function loadEvent(
  tabId: number,
  timeoutMs: number,
): { promise: Promise<boolean>; cancel(): void } {
  let off = () => undefined as unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<boolean>((resolve) => {
    off = cdp.onEvent((id, method) => {
      if (id === tabId && method === 'Page.loadEventFired') resolve(true);
    });
    timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
  }).finally(() => {
    off();
    clearTimeout(timer);
  });
  return {
    promise,
    cancel: () => {
      off();
      clearTimeout(timer);
    },
  };
}

/** Poll the tabs API until the tab has finished loading something other than about:blank. */
async function tabLoaded(tabId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete' && !t.pendingUrl && t.url !== 'about:blank') return;
    await sleep(100);
  }
}

/** Navigate with the tabs API, resolving once the tab has started and finished loading. */
async function navigateViaTabs(tabId: number, url: string, timeoutMs: number): Promise<void> {
  let sawLoading = false;
  const done = new Promise<void>((resolve) => {
    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
  await chrome.tabs.update(tabId, { url });
  await done;
}

async function navigate(ctx: Ctx, tabId: number, url: string): Promise<void> {
  if (/^(chrome|edge|brave|about:(?!blank))/i.test(url)) {
    // Browser pages can't be debugged; navigate without waiting.
    await chrome.tabs.update(tabId, { url });
    return;
  }
  // Page.navigate gives precise load tracking and network error text. Chrome sometimes swaps
  // the tab's renderer process when it starts, which detaches the debugger and drops the
  // navigation ("target_closed"): retry once on a fresh attach, then fall back to the tabs API.
  for (let attempt = 0; attempt < 2; attempt++) {
    const load = loadEvent(tabId, ctx.timeout);
    let r: { loaderId?: string; errorText?: string };
    try {
      r = await cdp.send(tabId, 'Page.navigate', { url });
    } catch (e) {
      load.cancel();
      if (!/detached|not attached/i.test(String(e))) throw e;
      await sleep(100);
      continue;
    }
    if (r.errorText) {
      load.cancel();
      throw new UserError(`Navigation to ${url} failed: ${r.errorText}`);
    }
    if (!r.loaderId)
      load.cancel(); // same-document navigation (e.g. #hash): nothing to wait for
    else await load.promise;
    return;
  }
  await navigateViaTabs(tabId, url, ctx.timeout);
}

/** Move through session history via CDP (the tabs API loses track after process swaps). */
async function goHistory(ctx: Ctx, tabId: number, delta: number): Promise<void> {
  const { currentIndex, entries } = await cdp.send<{
    currentIndex: number;
    entries: { id: number; url: string }[];
  }>(tabId, 'Page.getNavigationHistory');
  const entry = entries[currentIndex + delta];
  if (!entry) throw new UserError(`No ${delta < 0 ? 'previous' : 'next'} page in history`);
  await cdp.send(tabId, 'Page.navigateToHistoryEntry', { entryId: entry.id });
  // Back/forward-cache restores don't fire a load event, so poll for the result instead.
  const deadline = Date.now() + ctx.timeout;
  while (Date.now() < deadline) {
    const page = await evaluate(
      tabId,
      '({ url: location.href, ready: document.readyState })',
    ).catch(() => undefined);
    const v = page?.value as { url: string; ready: string } | undefined;
    if (v?.url === entry.url && v.ready === 'complete') return;
    await sleep(100);
  }
}

/** Open a new agent-owned tab in the background (doesn't steal the user's focus). */
async function newTab(ctx: Ctx, url?: string): Promise<number> {
  const win = await chrome.windows
    .getLastFocused({ windowTypes: ['normal'] })
    .catch(() => undefined);
  // Load the first URL through the tabs API: the first navigation out of a fresh tab swaps
  // renderer processes, which would detach a debugger attached to the blank page.
  const tab = await chrome.tabs.create({
    url: url ? normalizeUrl(url) : 'about:blank',
    active: false,
    windowId: win?.id,
  });
  if (tab.id === undefined) throw new Error('Failed to create a tab');
  await grant(tab.id, 'agent', ctx.session);
  ctx.setTab(tab.id);
  if (url) await tabLoaded(tab.id, ctx.timeout);
  return tab.id;
}

/** Used by `click --new-tab`. */
export async function openInNewTab(ctx: Ctx, url: string): Promise<Result> {
  const id = await newTab(ctx, url);
  save();
  return pageResult(id);
}

function currentTab(ctx: Ctx): number | undefined {
  const id = session(ctx.session).tab;
  return id !== undefined && isControlled(id) ? id : undefined;
}

function resolveTabRef(ref: string): number {
  if (/^\d+$/.test(ref)) throw new UserError(`Use a tab id like t${ref} (see \`bctl tab\`)`);
  const id = findTab(ref);
  if (id === undefined) throw new UserError(`Unknown tab: ${ref}. Run \`bctl tab\` to list tabs.`);
  return id;
}

const LABEL = /^[a-zA-Z][\w-]*$/;

export function setLabel(tabId: number, label: string): void {
  if (!LABEL.test(label) || /^t\d+$/i.test(label)) {
    throw new UserError('Labels start with a letter, use letters/digits/-/_, and are not t<N>');
  }
  const other = findTab(label);
  if (other !== undefined && other !== tabId) throw new UserError(`Label "${label}" is in use`);
  meta(tabId).label = label;
  save();
}

export const navigationCommands: Command[] = [
  {
    name: 'open',
    show: Infinity,
    aliases: ['goto', 'navigate'],
    group: 'Navigation',
    usage: 'open [url]',
    summary:
      "Navigate the session's tab; opens a new background tab if there is none (never navigates away from a tab the user shared)",
    async run(ctx, a) {
      const url = a.pos[0];
      let id = currentTab(ctx);
      // A tab the user shared is theirs: don't navigate it somewhere else, open our own instead.
      const shared = id !== undefined && state.tabs[id]?.control === 'user';
      if (id === undefined || (shared && url)) id = await newTab(ctx, url);
      else if (url) await navigate(ctx, id, normalizeUrl(url));
      ctx.setTab(id);
      save();
      return pageResult(id);
    },
  },
  {
    name: 'back',
    group: 'Navigation',
    usage: 'back',
    summary: 'Go back',
    async run(ctx) {
      const id = await ctx.tab();
      await goHistory(ctx, id, -1);
      return pageResult(id);
    },
  },
  {
    name: 'forward',
    group: 'Navigation',
    usage: 'forward',
    summary: 'Go forward',
    async run(ctx) {
      const id = await ctx.tab();
      await goHistory(ctx, id, 1);
      return pageResult(id);
    },
  },
  {
    name: 'reload',
    group: 'Navigation',
    usage: 'reload',
    summary: 'Reload the page',
    async run(ctx) {
      const id = await ctx.tab();
      const load = loadEvent(id, ctx.timeout);
      await cdp.send(id, 'Page.reload');
      await load.promise;
      return pageResult(id);
    },
  },
  {
    name: 'close',
    show: Infinity,
    aliases: ['quit', 'exit'],
    group: 'Navigation',
    usage: 'close',
    summary: "End the session: close tabs it opened and release the user's tabs",
    async run(ctx) {
      let closed = 0;
      let released = 0;
      const current = session(ctx.session).tab;
      for (const [key, m] of Object.entries(state.tabs)) {
        const id = Number(key);
        if (m.control === 'agent' && m.owner === ctx.session) {
          await chrome.tabs.remove(id).catch(() => undefined);
          closed++;
        } else if (id === current && m.control === 'user') {
          await revoke(id);
          released++;
        }
      }
      delete state.sessions[ctx.session];
      save();
      return {
        text: `✓ Session "${ctx.session}" closed (${closed} tab(s) closed, ${released} released)`,
        data: { closed, released },
      };
    },
  },
  {
    name: 'tab',
    show: Infinity,
    showFlags: ['label'],
    group: 'Tabs',
    usage: 'tab [list | new [--label L] [url] | <tN|label> | close [tN|label]]',
    summary: 'List tabs, open a tab, switch (asks the user for non-agent tabs), or close',
    flags: [{ name: 'label', type: 'string', desc: 'Label for `tab new`' }],
    async run(ctx, a) {
      const sub = a.pos[0] ?? 'list';

      if (sub === 'list') {
        const current = session(ctx.session).tab;
        const tabs = await chrome.tabs.query({ windowType: 'normal' });
        const rows = tabs.flatMap((t) => {
          if (t.id === undefined) return [];
          const m = meta(t.id);
          return [{ id: t.id, m, t, controlled: isControlled(t.id), current: t.id === current }];
        });
        const pendingIds = new Set(state.approvals.map((p) => p.tabId));
        const text = rows
          .map(({ id, m, t, controlled, current: cur }) => {
            const label = m.label ? ` (${m.label})` : '';
            const status = controlled
              ? ''
              : pendingIds.has(id)
                ? '  [pending approval]'
                : '  [not shared]';
            return `${cur ? '→' : ' '} [${m.tid}]${label} ${t.title ?? ''} - ${t.url ?? ''}${status}`;
          })
          .join('\n');
        return {
          text: `${text}\n\nTabs marked [not shared] need user approval: \`bctl tab <id>\` asks the user.`,
          data: rows.map(({ m, t, controlled, current: cur }) => ({
            tabId: m.tid,
            label: m.label,
            title: t.title,
            url: t.url,
            controlled,
            current: cur,
            active: t.active,
          })),
        };
      }

      if (sub === 'new') {
        const id = await newTab(ctx, a.pos[1]);
        const label = a.str('label');
        if (label) setLabel(id, label);
        save();
        return pageResult(id);
      }

      if (sub === 'close') {
        const id = a.pos[1] ? resolveTabRef(a.pos[1]) : await ctx.tab();
        if (!isControlled(id))
          throw new UserError(`Tab ${meta(id).tid} is not shared with the agent`);
        await chrome.tabs.remove(id);
        return { text: '✓ Done', data: { closed: true } };
      }

      // Switch to a tab, asking the user first if the agent doesn't control it.
      const id = resolveTabRef(sub);
      await requestControl(id, ctx.session, ctx.signal, ctx.progress);
      ctx.setTab(id);
      const label = a.str('label');
      if (label) setLabel(id, label);
      save();
      let revived = false;
      const t = await chrome.tabs.get(id);
      if (t.discarded) {
        const loaded = waitForLoad(id, ctx.timeout);
        await chrome.tabs.reload(id);
        await loaded;
        revived = true;
      }
      const res = await pageResult(id);
      return { ...res, data: { ...(res.data as object), revived } };
    },
  },
];
