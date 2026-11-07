const $ = (id) => document.getElementById(id);

async function render() {
  const { status = 'disconnected', detail = '' } = await chrome.storage.session.get(['status', 'detail']);
  const el = $('status');
  el.textContent = detail ? `${status} — ${detail}` : status;
  el.className = status === 'connected' ? 'connected' : status === 'error' ? 'error' : '';
}

async function init() {
  const cfg = await chrome.storage.local.get(['token', 'port', 'enabled']);
  $('token').value = cfg.token || '';
  $('port').value = cfg.port || 47823;
  $('enabled').checked = cfg.enabled !== false;
  await render();
  chrome.runtime.sendMessage({ type: 'reconnect' }).catch(() => {});
}

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    token: $('token').value.trim(),
    port: Number($('port').value) || 47823,
    enabled: $('enabled').checked,
  });
  await chrome.runtime.sendMessage({ type: 'reconnect', force: true }).catch(() => {});
});

chrome.storage.onChanged.addListener((_, area) => area === 'session' && render());
init();
