import { type Command, type Ctx, type Result } from '../command';
import * as cdp from '../cdp';
import { evaluate, UserError } from '../dom';
import { guardNavigation } from '../guardrails';
import { assertLanded, hasBlocked } from '../navigation-guard';
import {
  navData,
  navFailure,
  navTimeout,
  navWarnings,
  titleLine,
  type NavInfo,
} from '../nav-outcome';
import { findTab, meta, save, session, state } from '../state';
import { focusTab, grant, isControlled, requestControl, revoke, sleep, waitForLoad } from '../tabs';

export function normalizeUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url)) return `http://${url}`;
  return `https://${url}`;
}

/** What a navigation command reports about how the load went. */
interface NavReport {
  info: NavInfo;
  url: string;
  timeout: number;
}

async function pageResult(tabId: number, nav?: NavReport): Promise<Result> {
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
  const warnings = nav ? navWarnings(nav.info, nav.url || url, nav.timeout) : [];
  return {
    text: `${titleLine(title)}\n  ${url}`,
    data: { tabId: m.tid, label: m.label, title, url, ...(nav ? navData(nav.info) : {}) },
    ...(warnings.length ? { warning: warnings } : {}),
  };
}

/** HTTP status of the tab's main document (0/undefined when unknown); never waits long. */
async function docStatus(tabId: number): Promise<number | undefined> {
  if (!cdp.isAttached(tabId)) return undefined;
  const probe = evaluate(
    tabId,
    "(performance.getEntriesByType('navigation')[0] || {}).responseStatus || 0",
  ).then(
    (r) => (typeof r.value === 'number' && r.value > 0 ? r.value : undefined),
    () => undefined,
  );
  return Promise.race([probe, sleep(500).then(() => undefined)]);
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
async function tabLoaded(tabId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasBlocked(tabId)) return true; // the navigation guard refused the page and blanked the tab
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete' && !t.pendingUrl && t.url !== 'about:blank') return true;
    await sleep(100);
  }
  return false;
}

/** Has the tab committed anything beyond the blank page it started on? */
async function committed(tabId: number): Promise<boolean> {
  const t = await chrome.tabs.get(tabId).catch(() => undefined);
  return !!t?.url && t.url !== 'about:blank' && !t.url.startsWith('chrome-error:');
}

/** Navigate with the tabs API, resolving once the tab has started and finished loading. */
async function navigateViaTabs(tabId: number, url: string, timeoutMs: number): Promise<boolean> {
  let sawLoading = false;
  let complete = false;
  const done = new Promise<void>((resolve) => {
    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) {
        complete = true;
        finish();
      }
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
  return complete;
}

/**
 * Navigate and wait at most `ctx.timeout` ms in total. Page.navigate itself blocks until the
 * response commits, so it is raced against the deadline: if nothing committed in time the
 * command fails with `timeout`; if the page committed but is still loading, it succeeds with
 * `loaded: false`.
 */
async function navigate(ctx: Ctx, tabId: number, url: string): Promise<NavInfo> {
  if (/^(chrome|edge|brave|about:(?!blank))/i.test(url)) {
    // Browser pages can't be debugged; navigate without waiting.
    await chrome.tabs.update(tabId, { url });
    return { loaded: true };
  }
  const deadline = Date.now() + ctx.timeout;
  // Page.navigate gives precise load tracking and network error text. Chrome sometimes swaps
  // the tab's renderer process when it starts, which detaches the debugger and drops the
  // navigation ("target_closed"): retry once on a fresh attach, then fall back to the tabs API.
  for (let attempt = 0; attempt < 2; attempt++) {
    const load = loadEvent(tabId, Math.max(0, deadline - Date.now()));
    let r: { loaderId?: string; errorText?: string } | undefined;
    const sent = cdp.send<{ loaderId?: string; errorText?: string }>(tabId, 'Page.navigate', {
      url,
    });
    try {
      r = await Promise.race([
        sent,
        sleep(Math.max(0, deadline - Date.now())).then(() => undefined),
      ]);
    } catch (e) {
      load.cancel();
      if (!/detached|not attached/i.test(String(e))) throw e;
      await sleep(100);
      continue;
    }
    if (!r) {
      // No response committed in time (slow server). Stop the pending load and report it.
      load.cancel();
      sent.catch(() => undefined);
      await cdp.send(tabId, 'Page.stopLoading').catch(() => undefined);
      throw navTimeout(url, ctx.timeout);
    }
    if (r.errorText) {
      load.cancel();
      // Only an HTTP error response commits a document whose status is this navigation's; for
      // other failures (DNS, ERR_ABORTED…) the probe would read the previous page's status.
      const status =
        r.errorText === 'net::ERR_HTTP_RESPONSE_CODE_FAILURE' ? await docStatus(tabId) : undefined;
      throw navFailure(url, r.errorText, status);
    }
    if (!r.loaderId) {
      load.cancel(); // same-document navigation (e.g. #hash): nothing to wait for
      return { loaded: true };
    }
    const loaded = await load.promise;
    return { loaded, status: await docStatus(tabId) };
  }
  const loaded = await navigateViaTabs(tabId, url, Math.max(0, deadline - Date.now()));
  if (!loaded && !(await committed(tabId))) throw navTimeout(url, ctx.timeout);
  return { loaded, status: await docStatus(tabId) };
}

/** Move through session history via CDP (the tabs API loses track after process swaps). */
async function goHistory(ctx: Ctx, tabId: number, delta: number): Promise<NavInfo> {
  const { currentIndex, entries } = await cdp.send<{
    currentIndex: number;
    entries: { id: number; url: string }[];
  }>(tabId, 'Page.getNavigationHistory');
  const entry = entries[currentIndex + delta];
  if (!entry)
    throw new UserError(`No ${delta < 0 ? 'previous' : 'next'} page in history`, 'not_found');
  await cdp.send(tabId, 'Page.navigateToHistoryEntry', { entryId: entry.id });
  // Back/forward-cache restores don't fire a load event, so poll for the result instead.
  const deadline = Date.now() + ctx.timeout;
  while (Date.now() < deadline) {
    const page = await evaluate(
      tabId,
      '({ url: location.href, ready: document.readyState })',
    ).catch(() => undefined);
    const v = page?.value as { url: string; ready: string } | undefined;
    if (v?.url === entry.url && v.ready === 'complete') return { loaded: true };
    await sleep(100);
  }
  return { loaded: false };
}

/** Open a new agent-owned tab in the background (doesn't steal the user's focus). */
async function newTab(ctx: Ctx, url?: string): Promise<{ id: number; info: NavInfo }> {
  const win = await chrome.windows
    .getLastFocused({ windowTypes: ['normal'] })
    .catch(() => undefined);
  // Load the first URL through the tabs API: the first navigation out of a fresh tab swaps
  // renderer processes, which would detach a debugger attached to the blank page.
  if (url) await guardNavigation(ctx, normalizeUrl(url));
  const tab = await chrome.tabs.create({
    url: url ? normalizeUrl(url) : 'about:blank',
    active: false,
    windowId: win?.id,
  });
  if (tab.id === undefined) throw new Error('Failed to create a tab');
  await grant(tab.id, 'agent', ctx.session);
  ctx.setTab(tab.id);
  let info: NavInfo = { loaded: true };
  if (url) {
    const loaded = await tabLoaded(tab.id, ctx.timeout);
    if (!loaded && !(await committed(tab.id))) throw navTimeout(normalizeUrl(url), ctx.timeout);
    await assertLanded(ctx, tab.id);
    info = { loaded, status: await docStatus(tab.id) };
  }
  return { id: tab.id, info };
}

/** Used by `click --new-tab`. */
export async function openInNewTab(ctx: Ctx, url: string): Promise<Result> {
  const { id, info } = await newTab(ctx, url);
  save();
  return pageResult(id, { info, url: normalizeUrl(url), timeout: ctx.timeout });
}

function currentTab(ctx: Ctx): number | undefined {
  const id = session(ctx.session).tab;
  return id !== undefined && isControlled(id) ? id : undefined;
}

function resolveTabRef(ref: string): number {
  if (/^\d+$/.test(ref))
    throw new UserError(`Use a tab id like t${ref} (see \`bvl tab\`)`, 'bad_args');
  const id = findTab(ref);
  if (id === undefined)
    throw new UserError(`Unknown tab: ${ref}. Run \`bvl tab\` to list tabs.`, 'not_found');
  return id;
}

const LABEL = /^[a-zA-Z][\w-]*$/;

export function setLabel(tabId: number, label: string): void {
  if (!LABEL.test(label) || /^t\d+$/i.test(label)) {
    throw new UserError(
      'Labels start with a letter, use letters/digits/-/_, and are not t<N>',
      'bad_args',
    );
  }
  const other = findTab(label);
  if (other !== undefined && other !== tabId)
    throw new UserError(`Label "${label}" is in use`, 'bad_args');
  meta(tabId).label = label;
  save();
}

export const navigationCommands: Command[] = [
  {
    name: 'open',
    details:
      "Navigates the session's current agent tab, or opens a new background agent tab when there is none. If the current tab is one you shared, it opens a new agent tab instead of navigating yours. Prints the page title and URL. Does not wait for the page to be idle; use `wait --load networkidle` for that.",
    examples: ['bvl open https://example.com', 'bvl open localhost:3000'],
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
      let info: NavInfo | undefined;
      if (id === undefined || (shared && url)) ({ id, info } = await newTab(ctx, url));
      else if (url) {
        await guardNavigation(ctx, normalizeUrl(url));
        info = await navigate(ctx, id, normalizeUrl(url));
      }
      ctx.setTab(id);
      save();
      const target = url ? normalizeUrl(url) : '';
      return pageResult(id, info && { info, url: target, timeout: ctx.timeout });
    },
  },
  {
    name: 'back',
    group: 'Navigation',
    usage: 'back',
    summary: 'Go back',
    async run(ctx) {
      const id = await ctx.tab();
      const info = await goHistory(ctx, id, -1);
      return pageResult(id, { info, url: '', timeout: ctx.timeout });
    },
  },
  {
    name: 'forward',
    group: 'Navigation',
    usage: 'forward',
    summary: 'Go forward',
    async run(ctx) {
      const id = await ctx.tab();
      const info = await goHistory(ctx, id, 1);
      return pageResult(id, { info, url: '', timeout: ctx.timeout });
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
      const loaded = await load.promise;
      const info: NavInfo = { loaded, status: loaded ? await docStatus(id) : undefined };
      return pageResult(id, { info, url: '', timeout: ctx.timeout });
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
    details:
      'Without arguments lists tabs; `tab show [tN|label]` brings an agent or shared tab and its window to the front (default: the current tab) so the user can take over; it changes no grants and not the current tab, and is the only command that focuses a tab. `[not shared]` marks tabs you opened yourself that the agent may not use. Switching to a tab the agent did not open asks the user in the browser and waits for the answer (code `denied` if refused). `tab new` opens an agent tab, `tab close` closes one.',
    examples: [
      'bvl tab',
      'bvl tab t3',
      'bvl tab new --label docs https://example.com',
      'bvl tab show t3',
      'bvl tab close docs',
    ],
    show: Infinity,
    showFlags: ['label'],
    group: 'Tabs',
    usage: 'tab [list | new [--label L] [url] | show [tN|label] | <tN|label> | close [tN|label]]',
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
          text,
          warning: rows.some((r) => !r.controlled)
            ? 'Tabs marked [not shared] need user approval: `bvl tab <id>` asks the user.'
            : undefined,
          data: {
            tabs: rows.map(({ id, m, t, controlled, current: cur }) => ({
              tabId: m.tid,
              label: m.label ?? null,
              title: t.title,
              url: t.url,
              active: t.active,
              type: 'page',
              controlled,
              pending: pendingIds.has(id),
              current: cur,
            })),
          },
        };
      }

      if (sub === 'new') {
        const { id, info } = await newTab(ctx, a.pos[1]);
        const label = a.str('label');
        if (label) setLabel(id, label);
        save();
        return pageResult(id, {
          info,
          url: a.pos[1] ? normalizeUrl(a.pos[1]) : '',
          timeout: ctx.timeout,
        });
      }

      if (sub === 'show') {
        const id = a.pos[1] ? resolveTabRef(a.pos[1]) : await ctx.tab();
        if (!isControlled(id))
          throw new UserError(`Tab ${meta(id).tid} is not shared with the agent`, 'not_shared');
        const focused = await focusTab(id);
        return {
          text: focused ? `✓ Showing [${meta(id).tid}]` : `⚠ Could not focus [${meta(id).tid}]`,
          data: { tabId: meta(id).tid, focused },
          ...(focused
            ? {}
            : { warning: 'Chrome refused to focus the tab; its window was flagged instead.' }),
        };
      }

      if (sub === 'close') {
        const id = a.pos[1] ? resolveTabRef(a.pos[1]) : await ctx.tab();
        if (!isControlled(id))
          throw new UserError(`Tab ${meta(id).tid} is not shared with the agent`, 'not_shared');
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
