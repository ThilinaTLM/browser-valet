// Service-worker entry point. Listeners are registered synchronously (MV3 requirement); state is
// loaded before anything that needs it runs.

import type { PopupMessage } from '../shared';
import { connect, disconnect, startKeepAlive } from './connection';
import { loadState, regenerateSecret, save, state, updateSettings } from './state';
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
      for (const [id, m] of Object.entries(state.tabs)) if (m.control) await revoke(Number(id));
      break;
    case 'settings':
      await updateSettings(msg.settings);
      disconnect();
      connect();
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
