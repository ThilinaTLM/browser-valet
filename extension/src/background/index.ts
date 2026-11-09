// Service-worker entry point. Listeners are registered synchronously (MV3 requirement); state is
// loaded before anything that needs it runs.

import type { PopupMessage } from '../shared';
import { connect, disconnect, startKeepAlive } from './connection';
import { loadState, regenerateSecret, save, state, updateSettings } from './state';
import { updateGuardrails } from './guardrails';
import { decide, grant, refreshBadge, refreshGlobalBadge, revoke } from './tabs';

const ready = loadState().then(async () => {
  save(); // publish initial state so the popup can render before anything happens
  // Re-apply badges (they don't survive browser restarts; state might have).
  for (const id of Object.keys(state.tabs)) await refreshBadge(Number(id));
  await refreshGlobalBadge();
  connect();
});

chrome.runtime.onStartup.addListener(() => void ready.then(connect));
chrome.runtime.onInstalled.addListener(() => void ready.then(connect));
void chrome.alarms.create('bctl-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => void ready.then(connect));
startKeepAlive();

/** Stop controlling every tab and deny every pending approval. */
async function revokeAll(): Promise<void> {
  for (const a of state.approvals) decide(a.id, false);
  state.approvals = []; // also drops orphans whose waiter died with an earlier service worker
  await refreshGlobalBadge();
  for (const [id, m] of Object.entries(state.tabs)) if (m.control) await revoke(Number(id));
}

async function handle(msg: PopupMessage): Promise<void> {
  await ready;
  switch (msg.type) {
    case 'ping': // the popup opened: wake up and (re)publish state
      connect();
      break;
    case 'decide':
      decide(msg.id, msg.allow);
      break;
    case 'share':
      await grant(msg.tabId, 'user');
      break;
    case 'revoke':
      await revoke(msg.tabId);
      break;
    case 'revokeAll':
      await revokeAll();
      break;
    case 'settings':
      await updateSettings(msg.settings);
      // Turning the extension off ends all agent control; turning it on again starts from scratch.
      if (msg.settings.enabled === false) await revokeAll();
      disconnect();
      connect();
      break;
    case 'guardrails':
      await updateGuardrails(msg.guardrails);
      break;
    case 'repair':
      await regenerateSecret();
      disconnect();
      connect();
      break;
  }
  save();
}

chrome.runtime.onMessage.addListener((msg: PopupMessage, _sender, sendResponse) => {
  handle(msg).then(
    () => {
      sendResponse({ ok: true });
    },
    (e: unknown) => {
      sendResponse({ ok: false, error: String(e) });
    },
  );
  return true;
});
