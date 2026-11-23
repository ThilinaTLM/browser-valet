// The on/off switch: the user's emergency stop, also flipped off automatically when bvl goes away.
// See security.md ("Tab consent and grants") and runtime.md.

import type { OffReason } from '../shared';
import { save, settings, state, updateSettings } from './state';
import { clearControl, decide, refreshGlobalBadge, revoke } from './tabs';

const ICON_ON = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' };
const ICON_OFF = { 16: 'icons/icon-off-16.png', 32: 'icons/icon-off-32.png' };

/** Stop controlling every tab and deny every pending approval. */
export async function revokeAll(): Promise<void> {
  for (const a of state.approvals) decide(a.id, false);
  state.approvals = []; // also drops orphans whose waiter died with an earlier service worker
  await refreshGlobalBadge();
  // Strip every grant first (one save), then let go of the debuggers in parallel: a hung detach
  // of one tab must not keep the others, or the switch, waiting.
  const ids = Object.entries(state.tabs)
    .filter(([, m]) => m.control)
    .map(([id]) => Number(id));
  // (`revoke` clears again, which is harmless; this pass makes the strip atomic for all tabs.)
  for (const id of ids) clearControl(id);
  await Promise.all(ids.map((id) => revoke(id)));
}

/** Toolbar icon and title follow the switch, so "off" is visible at a glance. */
export async function refreshIcon(): Promise<void> {
  try {
    await chrome.action.setIcon({ path: settings.enabled ? ICON_ON : ICON_OFF });
    await chrome.action.setTitle({
      title: settings.enabled ? 'Browser Valet' : 'Browser Valet: off',
    });
  } catch {
    // icon files missing in an odd build; the popup still shows the state
  }
}

/**
 * Flip the switch. Off ends all control (grants revoked, approvals denied); on starts from scratch.
 * `reason` records why it switched itself off, for the popup.
 */
export async function setEnabled(enabled: boolean, reason?: OffReason): Promise<void> {
  await updateSettings({ enabled });
  if (enabled) delete state.conn.offReason;
  else if (reason) state.conn.offReason = reason;
  if (!enabled) await revokeAll();
  save();
  await refreshIcon();
}
