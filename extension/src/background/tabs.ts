// Tab control: which tabs the agent may drive, asking the user for consent, badges, and
// navigation helpers.

import type { Control } from '../shared';
import * as cdp from './cdp';
import { UserError } from './errors';
import { forgetBaselines } from './snapshot-diff';
import { forgetTab, handoffGraceUntil, meta, save, state } from './state';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function isControlled(tabId: number): boolean {
  return state.tabs[tabId]?.control !== undefined;
}

export async function grant(tabId: number, control: Control, owner?: string): Promise<void> {
  const m = meta(tabId);
  m.control = control;
  if (owner) m.owner = owner;
  save();
  await refreshBadge(tabId);
}

export async function revoke(tabId: number): Promise<void> {
  const m = state.tabs[tabId];
  if (m) {
    delete m.control;
    delete m.owner;
    delete state.refs[tabId];
    delete state.refDocs[tabId];
    forgetBaselines(tabId);
    save();
  }
  await cdp.detach(tabId);
  await refreshBadge(tabId);
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

const APPROVAL_TIMEOUT_MS = 120_000;
const pending = new Map<
  string,
  { resolve: (allow: boolean) => void; reject: (e: Error) => void }
>();

/** Called by the popup when the user clicks Allow / Deny. */
export function decide(id: string, allow: boolean): void {
  pending.get(id)?.resolve(allow);
}

/** Fail the waiting CLI request of every pending approval for `tabId` (e.g. the tab was closed). */
function failApprovals(tabId: number, error: Error): void {
  for (const a of state.approvals) if (a.tabId === tabId) pending.get(a.id)?.reject(error);
}

async function showApprovalUi(windowId: number): Promise<void> {
  try {
    await chrome.windows.update(windowId, { drawAttention: true });
    await chrome.action.openPopup({ windowId });
  } catch {
    // No focused browser window (e.g. the user is in a terminal): open a small window instead.
    await chrome.windows.create({
      url: 'popup.html?window=1',
      type: 'popup',
      width: 380,
      height: 600,
      focused: true,
    });
  }
}

/** Ask the user to let the agent control `tabId`. Resolves when allowed; throws otherwise. */
export async function requestControl(
  tabId: number,
  session: string,
  signal: AbortSignal,
  progress: (text: string) => void,
): Promise<void> {
  if (isControlled(tabId)) return;
  const tab = await chrome.tabs.get(tabId);
  const m = meta(tabId);
  const id = crypto.randomUUID();
  state.approvals.push({ id, tabId, session, ts: Date.now() });
  save();
  await refreshGlobalBadge();
  progress(`Waiting for the user to allow control of [${m.tid}] ${tab.title ?? ''} …\n`);
  void showApprovalUi(tab.windowId);

  try {
    const allowed = await new Promise<boolean>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        reject(
          new UserError(
            `The user did not respond within ${APPROVAL_TIMEOUT_MS / 1000}s`,
            'timeout',
          ),
        );
      }, APPROVAL_TIMEOUT_MS);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('cancelled'));
      });
    });
    if (!allowed) throw new UserError(`The user denied control of ${m.tid}`, 'denied');
    await grant(tabId, 'user');
  } finally {
    pending.delete(id);
    state.approvals = state.approvals.filter((a) => a.id !== id);
    save();
    await refreshGlobalBadge();
  }
}

// ---------------------------------------------------------------------------
// Badges: "AI" on controlled tabs, "!" while an approval is pending.
// ---------------------------------------------------------------------------

// Nerve Light primary (ember) and warning; both keep white badge text readable.
const BADGE_CONTROLLED = '#b95634';
const BADGE_PENDING = '#9a4c00';

export async function refreshBadge(tabId: number): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: isControlled(tabId) ? 'AI' : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_CONTROLLED });
  } catch {
    // tab is gone
  }
}

export async function refreshGlobalBadge(): Promise<void> {
  const waiting = state.approvals.length > 0;
  await chrome.action.setBadgeText({ text: waiting ? '!' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_PENDING });
}

// ---------------------------------------------------------------------------
// Tab lifecycle
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  failApprovals(
    tabId,
    new UserError('The tab was closed while waiting for the user to allow control', 'tab_gone'),
  );
  forgetTab(tabId);
  void cdp.detach(tabId);
});

// Tabs opened by a controlled tab (popups, OAuth windows, target=_blank) are the agent's too.
chrome.tabs.onCreated.addListener((tab) => {
  const opener = tab.openerTabId !== undefined ? state.tabs[tab.openerTabId] : undefined;
  if (tab.id !== undefined && opener?.control) void grant(tab.id, 'agent', opener.owner);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete' && isControlled(tabId)) void refreshBadge(tabId);
});

// The user closed Chrome's debugging bar: treat it as "stop controlling this tab".
// (Not right after a self-update reload, which drops all debugger attachments; those re-attach
// lazily on the next command.)
cdp.setOnUserDetach((tabId) => {
  if (Date.now() < handoffGraceUntil) return;
  void revoke(tabId);
});

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

/** Wait for the tab's next `complete` status. Never rejects; returns false on timeout. */
export function waitForLoad(tabId: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(ok);
    };
    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id === tabId && info.status === 'complete') finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

/** After an action: if it started a navigation, wait for it to finish. */
export async function settle(tabId: number, timeoutMs = 15_000): Promise<void> {
  await sleep(120);
  try {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'loading') await waitForLoad(tabId, timeoutMs);
  } catch {
    // closed
  }
}
