// Allowed-domains policy, layer 2: navigations the page starts (redirects, `location = …`, link
// clicks, popups). On agent tabs, while a policy is active, `Fetch.enable` pauses *document*
// requests only and fails the main-frame ones whose host is not allowed (iframes load freely). Nothing is mocked or modified:
// allowed requests continue untouched, and only Document requests are ever paused (never
// scripts, images, XHR or fetch). See security.md ("Guardrails").
//
// Shared tabs are not guarded here: the user may browse in them. The commands layer
// (`assertNavigable`) still checks what the agent itself asks for.

import * as cdp from './cdp';
import type { Ctx } from './command';
import { blockedBy, blockedError, guardrails } from './guardrails';
import { session as sessionState, state } from './state';
import { isControlled } from './tabs';

/** Schemes that reach the network or disk; everything else (data:, blob:, about:, error pages) is not ours to judge. */
const GUARDED_SCHEMES = new Set(['http:', 'https:', 'file:', 'ftp:']);

/** The agent's own `--allowed-domains` of commands in flight, by session. */
const narrowing = new Map<string, string[]>();
/** Tabs where we turned `Fetch` on (in memory; a restarted worker re-syncs on the next attach). */
const guarded = new Set<number>();
/** Blocked navigations not yet reported to the agent, by tab. */
const unreported = new Map<number, string[]>();

let ready: Promise<unknown> = Promise.resolve();
/** The worker's startup promise: events wait for it so policy and tab state are loaded. */
export function setReady(p: Promise<unknown>): void {
  ready = p;
}

function agentList(tabId: number): string[] | undefined {
  const owner = state.tabs[tabId]?.owner;
  return owner ? narrowing.get(owner) : undefined;
}

/** Is `url` a navigation the policy refuses on this tab? (Only network/disk URLs are judged.) */
export function refusedOn(tabId: number, url: string): 'user' | 'agent' | undefined {
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    return undefined;
  }
  if (!GUARDED_SCHEMES.has(scheme)) return undefined;
  return blockedBy(url, agentList(tabId));
}

function shouldGuard(tabId: number): boolean {
  if (state.tabs[tabId]?.control !== 'agent') return false;
  return guardrails.allowedDomains.length > 0 || agentList(tabId) !== undefined;
}

function note(tabId: number, url: string): void {
  let host = url;
  try {
    host = new URL(url).host || url;
  } catch {
    // keep the raw text
  }
  const list = unreported.get(tabId) ?? [];
  list.push(host);
  unreported.set(tabId, list.slice(-5));
}

/** Blocked navigations since the last report on this tab (and forget them). */
export function takeBlocked(tabId: number | undefined): string[] {
  if (tabId === undefined) return [];
  const list = unreported.get(tabId) ?? [];
  unreported.delete(tabId);
  return list;
}

/** Has a navigation on this tab been refused and not yet reported? */
export function hasBlocked(tabId: number): boolean {
  return (unreported.get(tabId)?.length ?? 0) > 0;
}

/** The sentence for a blocked navigation, for warnings and errors. */
export function blockedMessage(hosts: string[]): string {
  return `Navigation to ${[...new Set(hosts)].join(', ')} was blocked by the allowed-domains policy (domain_blocked)`;
}

/** Bring Fetch interception on `tabId` in line with the policy. Never throws. */
export async function syncTab(tabId: number): Promise<void> {
  if (!cdp.isAttached(tabId)) return;
  const want = shouldGuard(tabId);
  try {
    if (want) {
      if (!mainFrames.has(tabId)) await rememberMainFrame(tabId);
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
        patterns: [{ resourceType: 'Document', requestStage: 'Request' }],
      });
      guarded.add(tabId);
    } else if (guarded.delete(tabId)) {
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.disable');
    }
  } catch {
    // The tab went away or the debugger detached; the next attach re-syncs.
  }
}

/** Re-sync every attached agent tab (the user changed the policy). */
export async function syncAll(): Promise<void> {
  for (const id of Object.keys(state.tabs)) await syncTab(Number(id));
}

/**
 * Apply the agent's `--allowed-domains` to the session's tab while the command runs, so that
 * redirects during the command are covered too. Returns the release function.
 */
export async function narrowFor(ctx: Ctx): Promise<() => void> {
  const list = ctx.agentAllowedDomains;
  if (!list) return () => undefined;
  narrowing.set(ctx.session, list);
  const tab = sessionState(ctx.session).tab;
  if (tab !== undefined) await syncTab(tab);
  return () => {
    if (narrowing.get(ctx.session) !== list) return;
    narrowing.delete(ctx.session);
    const t = sessionState(ctx.session).tab;
    if (t !== undefined) void syncTab(t);
  };
}

/**
 * A new tab loaded its first page through the tabs API, before any debugger could watch it. If it
 * ended up somewhere the policy refuses (a redirect), blank it and fail.
 */
export async function assertLanded(ctx: Ctx, tabId: number): Promise<void> {
  const url = (await chrome.tabs.get(tabId)).url ?? '';
  const by = refusedOn(tabId, url);
  if (!by) return;
  await chrome.tabs.update(tabId, { url: 'about:blank' });
  throw blockedError(
    url,
    by,
    (by === 'user' ? guardrails.allowedDomains : ctx.agentAllowedDomains) ?? [],
  );
}

/** The main frame id of each guarded tab (read before Fetch is enabled, kept by frameNavigated). */
const mainFrames = new Map<number, string>();

async function rememberMainFrame(tabId: number): Promise<void> {
  try {
    const tree: { frameTree?: { frame?: { id?: string } } } | undefined =
      await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree');
    const id = tree?.frameTree?.frame?.id;
    if (id) mainFrames.set(tabId, id);
  } catch {
    // unknown: treated as the main frame below
  }
}

/**
 * Is `frameId` the tab's main frame? Only top-level navigations are blocked: a cross-site iframe
 * (SSO, captcha, payment) on an allowed page keeps loading, since subresources are not blocked
 * either and the agent never navigates a frame by itself. The id is cached rather than asked for
 * here, because commands sent while a request is paused can stall. Unknown → true (fail closed).
 */
function isMainFrame(tabId: number, frameId: string | undefined): boolean {
  const main = mainFrames.get(tabId);
  return !frameId || main === undefined || main === frameId;
}

// --- events ------------------------------------------------------------------------------------

cdp.onAttached((tabId) => {
  void syncTab(tabId);
});

cdp.onDetached((tabId) => {
  guarded.delete(tabId);
  mainFrames.delete(tabId);
  unreported.delete(tabId);
});

cdp.onEvent((tabId, method, params) => {
  if (method === 'Page.frameNavigated') {
    const f = (params as { frame?: { id?: string; parentId?: string } }).frame;
    if (f?.id && !f.parentId) mainFrames.set(tabId, f.id);
    return;
  }
  if (method !== 'Fetch.requestPaused') return;
  void (async () => {
    const p = params as {
      requestId: string;
      frameId?: string;
      request: { url: string };
      resourceType?: string;
    };
    let block = true; // fail closed: a surprise here must not let a navigation through
    try {
      await ready;
      block =
        shouldGuard(tabId) &&
        refusedOn(tabId, p.request.url) !== undefined &&
        isMainFrame(tabId, p.frameId);
    } catch {
      // keep block = true
    }
    try {
      if (block) {
        note(tabId, p.request.url);
        await chrome.debugger.sendCommand({ tabId }, 'Fetch.failRequest', {
          requestId: p.requestId,
          errorReason: 'BlockedByClient',
        });
      } else {
        await chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', {
          requestId: p.requestId,
        });
      }
    } catch {
      // the request or the tab is gone
    }
  })();
});

// A popup opened by an agent tab (target=_blank, window.open) becomes an agent tab by opener
// grant. Attach right away so its navigation is watched, if a policy is active.
chrome.tabs.onCreated.addListener((tab) => {
  const id = tab.id;
  if (id === undefined) return;
  void (async () => {
    await ready;
    if (!isControlled(id) || !shouldGuard(id)) return;
    try {
      await cdp.attach(id);
    } catch {
      // not debuggable (e.g. a browser page)
    }
  })();
});

// Safety net for what Fetch cannot see (service-worker responses, history navigations): an agent
// tab that committed a refused URL is sent to about:blank.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  const url = info.url;
  if (!url) return;
  void (async () => {
    await ready;
    if (!shouldGuard(tabId) || !refusedOn(tabId, url)) return;
    note(tabId, url);
    await chrome.tabs.update(tabId, { url: 'about:blank' }).catch(() => undefined);
  })();
});
