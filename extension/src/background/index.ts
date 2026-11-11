// Service-worker entry point. Listeners are registered synchronously (MV3 requirement); state is
// loaded before anything that needs it runs.

import type { PopupMessage } from '../shared';
import { connect, disconnect, startKeepAlive } from './connection';
import { loadState, regenerateSecret, save, state, updateSettings } from './state';
import { setReady, syncAll } from './navigation-guard';
import { loadGuardrails, updateGuardrails } from './guardrails';
import { refreshIcon, revokeAll, setEnabled } from './switch';
import { decide, grant, refreshBadge, refreshGlobalBadge, revoke } from './tabs';

const ready = loadState().then(async () => {
  await loadGuardrails();
  save(); // publish initial state so the popup can render before anything happens
  // Re-apply badges (they don't survive browser restarts; state might have).
  for (const id of Object.keys(state.tabs)) await refreshBadge(Number(id));
  await refreshGlobalBadge();
  await refreshIcon();
  connect();
});

setReady(ready);

chrome.runtime.onStartup.addListener(() => void ready.then(connect));
chrome.runtime.onInstalled.addListener(() => void ready.then(connect));
void chrome.alarms.create('bvl-keepalive', { periodInMinutes: 0.5 });
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
      await revokeAll();
      break;
    case 'settings': {
      const { enabled, ...rest } = msg.settings;
      if (Object.keys(rest).length) await updateSettings(rest);
      // Turning the extension off ends all agent control; turning it on again starts from scratch.
      if (enabled !== undefined) await setEnabled(enabled);
      disconnect();
      connect();
      break;
    }
    case 'guardrails':
      await updateGuardrails(msg.guardrails);
      await syncAll();
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
