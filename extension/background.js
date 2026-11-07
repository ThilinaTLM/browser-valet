// Browser Bridge — service worker.
// Connects out to the local `bctl` daemon over WebSocket and executes commands
// against tabs using the chrome.debugger (CDP) API.

const DEFAULT_PORT = 47823;
const VERSION = chrome.runtime.getManifest().version;

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

let ws = null;
let connecting = false;
let retryTimer = null;
let backoff = 1000;

async function setStatus(status, detail = '') {
  await chrome.storage.session.set({ status, detail });
  chrome.action.setBadgeText({ text: status === 'connected' ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#1a7f37' });
}

async function getConfig() {
  const c = await chrome.storage.local.get(['port', 'token', 'enabled']);
  return { port: c.port || DEFAULT_PORT, token: c.token || '', enabled: c.enabled !== false };
}

function scheduleReconnect() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, backoff);
  backoff = Math.min(backoff * 2, 10000);
}

async function connect(force = false) {
  if (force && ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  if (connecting || (ws && ws.readyState <= WebSocket.OPEN)) return;
  connecting = true;
  try {
    const cfg = await getConfig();
    if (!cfg.enabled) return setStatus('disabled');
    if (!cfg.token) return setStatus('error', 'no token set (run `bctl token`)');
    const sock = new WebSocket(`ws://127.0.0.1:${cfg.port}/ext?token=${encodeURIComponent(cfg.token)}`);
    ws = sock;
    sock.onopen = () => {
      backoff = 1000;
      setStatus('connected', `127.0.0.1:${cfg.port}`);
      const browser = (navigator.userAgentData?.brands || [])
        .filter((b) => !/not.?a.?brand/i.test(b.brand))
        .map((b) => `${b.brand} ${b.version}`)
        .join(', ') || navigator.userAgent;
      sock.send(JSON.stringify({ type: 'hello', version: VERSION, browser }));
    };
    sock.onmessage = (ev) => handleMessage(sock, ev.data);
    sock.onclose = () => {
      if (ws === sock) ws = null;
      setStatus('disconnected', 'daemon not reachable or token rejected; retrying');
      scheduleReconnect();
    };
    sock.onerror = () => {};
  } catch (e) {
    setStatus('error', String(e?.message || e));
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

// Keep the socket (and therefore the service worker) alive.
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
}, 20000);

// Wake periodically so we reconnect even if the worker was suspended.
chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'reconnect') {
    backoff = 1000;
    connect(!!msg.force).then(() => sendResponse({ ok: true }));
    return true;
  }
});
connect();

async function handleMessage(sock, data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (msg.id == null || !msg.cmd) return;
  let reply;
  try {
    const fn = COMMANDS[msg.cmd];
    if (!fn) throw new Error(`unknown command: ${msg.cmd}`);
    const result = await fn(msg.args || {}, msg.tab);
    reply = { id: msg.id, ok: true, result: result === undefined ? null : result };
  } catch (e) {
    reply = { id: msg.id, ok: false, error: String(e?.message || e) };
  }
  if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(reply));
}

// ---------------------------------------------------------------------------
// Tab + CDP helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const attached = new Set();

chrome.debugger.onDetach.addListener((src) => attached.delete(src.tabId));
chrome.tabs.onRemoved.addListener(async (tabId) => {
  attached.delete(tabId);
  chrome.storage.session.remove(`refs_${tabId}`);
  const { currentTab } = await chrome.storage.session.get('currentTab');
  if (currentTab === tabId) chrome.storage.session.remove('currentTab');
});

async function resolveTab(explicit) {
  if (explicit != null) return Number(explicit);
  const { currentTab } = await chrome.storage.session.get('currentTab');
  if (currentTab != null) {
    try { await chrome.tabs.get(currentTab); return currentTab; } catch {}
  }
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error('no active tab');
  await chrome.storage.session.set({ currentTab: t.id });
  return t.id;
}

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    // Possibly still attached from before a service-worker restart.
    if (!/already attached/i.test(String(e?.message))) throw e;
  }
  attached.add(tabId);
}

async function cdp(tabId, method, params = {}) {
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

function exceptionText(d) {
  return d?.exception?.description || d?.exception?.value || d?.text || 'exception';
}

async function evaluate(tabId, expression) {
  const r = await cdp(tabId, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  if (r.exceptionDetails) throw new Error(exceptionText(r.exceptionDetails));
  return r.result.value !== undefined ? r.result.value : (r.result.description ?? null);
}

async function callOn(tabId, objectId, fn, args = []) {
  const r = await cdp(tabId, 'Runtime.callFunctionOn', {
    objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })),
    returnByValue: true, awaitPromise: true, userGesture: true,
  });
  if (r.exceptionDetails) throw new Error(exceptionText(r.exceptionDetails));
  return r.result.value;
}

function waitForTabComplete(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (timedOut) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve({ timedOut });
    };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(false); };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(true), timeout);
    chrome.tabs.get(tabId).catch(() => finish(true)); // tab vanished
  });
}

// After an action, if it triggered a navigation, wait for it to finish.
async function settle(tabId) {
  await sleep(150);
  try {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'loading') await waitForTabComplete(tabId, 15000);
  } catch {}
}

async function tabInfo(tabId) {
  const t = await chrome.tabs.get(tabId);
  return { id: t.id, title: t.title, url: t.url };
}

async function getRefs(tabId) {
  const key = `refs_${tabId}`;
  return (await chrome.storage.session.get(key))[key] || {};
}

// target: "@e3" / "e3" (snapshot ref) or a CSS selector. Returns a CDP objectId.
async function resolveTarget(tabId, target) {
  if (!target) throw new Error('missing target');
  const m = /^@?(e\d+)$/.exec(target);
  if (m) {
    const backendNodeId = (await getRefs(tabId))[m[1]];
    if (!backendNodeId) throw new Error(`unknown ref ${target}; take a new snapshot`);
    try {
      const { object } = await cdp(tabId, 'DOM.resolveNode', { backendNodeId });
      return object.objectId;
    } catch {
      throw new Error(`ref ${target} is stale (page changed); take a new snapshot`);
    }
  }
  const r = await cdp(tabId, 'Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(target)})`,
  });
  if (r.exceptionDetails) throw new Error(`invalid selector: ${target}`);
  if (!r.result.objectId) throw new Error(`no element matches ${target}`);
  return r.result.objectId;
}

async function centerOf(tabId, objectId) {
  try { await cdp(tabId, 'DOM.scrollIntoViewIfNeeded', { objectId }); } catch {}
  const box = await callOn(tabId, objectId, `function () {
    const el = this.nodeType === 1 ? this : this.parentElement;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }`);
  if (!box || (box.w === 0 && box.h === 0)) throw new Error('element is not visible');
  return box;
}

async function mouseClick(tabId, x, y, { button = 'left', clickCount = 1 } = {}) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let i = 1; i <= clickCount; i++) {
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i });
  }
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Insert: { code: 'Insert', keyCode: 45 },
};
for (let i = 1; i <= 12; i++) KEYS[`F${i}`] = { code: `F${i}`, keyCode: 111 + i };
const ALIASES = { esc: 'Escape', return: 'Enter', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', space: 'Space' };
const MODS = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

function keyDef(name) {
  const canonical = ALIASES[name.toLowerCase()] ||
    Object.keys(KEYS).find((k) => k.toLowerCase() === name.toLowerCase());
  if (canonical) return { key: canonical, ...KEYS[canonical] };
  if ([...name].length === 1) {
    const ch = name;
    const upper = ch.toUpperCase();
    let code = '', keyCode = ch.charCodeAt(0);
    if (/[a-z]/i.test(ch)) { code = `Key${upper}`; keyCode = upper.charCodeAt(0); }
    else if (/[0-9]/.test(ch)) code = `Digit${ch}`;
    return { key: ch, code, keyCode, text: ch };
  }
  throw new Error(`unknown key: ${name}`);
}

async function pressKey(tabId, combo) {
  const parts = combo === '+' ? ['+'] : combo.split('+').filter(Boolean);
  const keyName = parts.pop();
  let modifiers = 0;
  for (const p of parts) {
    const m = MODS[p.toLowerCase()];
    if (!m) throw new Error(`unknown modifier: ${p}`);
    modifiers |= m;
  }
  const def = keyDef(keyName);
  let text = def.text;
  if (modifiers & 8 && text && text.length === 1) text = text.toUpperCase();
  if (modifiers & (2 | 4 | 1)) text = undefined; // shortcuts don't insert text
  const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers };
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', text, unmodifiedText: text });
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

async function typeText(tabId, text) {
  for (const ch of text) {
    if (ch === '\n') { await pressKey(tabId, 'Enter'); continue; }
    const def = /^[\x20-\x7e]$/.test(ch) ? keyDef(ch) : { key: ch, code: '', keyCode: 0 };
    const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode };
    await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyDown', text: ch, unmodifiedText: ch });
    await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }
}

// ---------------------------------------------------------------------------
// Accessibility snapshot
// ---------------------------------------------------------------------------

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio',
  'switch', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab',
  'treeitem', 'textField', 'TextField', 'PopUpButton', 'ComboBoxMenuButton', 'ComboBoxSelect',
]);
const SKIP = new Set(['InlineTextBox', 'LineBreak']);
const FLATTEN_UNNAMED = new Set(['generic', 'none', 'presentation', 'GenericContainer', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell', 'group', 'Section', 'LabelText', 'MenuListPopup']);
const FIELDS = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'TextField']);
const REF_ROLES = new Set(['heading', 'img', 'image', 'cell', 'row', 'listitem', 'dialog', 'alert', 'Iframe']);

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const q = (s) => JSON.stringify(s);

async function snapshot(tabId, { interactive = false, depth = null }) {
  await cdp(tabId, 'Accessibility.enable');
  const { nodes } = await cdp(tabId, 'Accessibility.getFullAXTree');
  if (!nodes?.length) return { text: '(empty)', refs: 0 };
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const refs = {};
  const lines = [];
  let counter = 0;

  const prop = (n, name) => n.properties?.find((p) => p.name === name)?.value?.value;

  function walk(node, level, parentName, inField) {
    const role = node.role?.value || '';
    const name = String(node.name?.value ?? '').replace(/\s+/g, ' ').trim();
    let show = !node.ignored && !SKIP.has(role);
    if (show && FLATTEN_UNNAMED.has(role) && !name) show = false;
    const isText = role === 'StaticText';
    if (show && isText && (!name || name === parentName || inField)) show = false;
    const focusable = prop(node, 'focusable') === true;
    const isInteractive = INTERACTIVE.has(role) || (focusable && role !== 'RootWebArea' && !isText);
    if (show && interactive && !isInteractive) show = false;
    if (depth != null && level > depth) show = false;

    let childLevel = level;
    if (show) {
      let line;
      if (isText) {
        line = `- text: ${trunc(name, 200)}`;
      } else {
        line = `- ${role === 'RootWebArea' ? 'document' : role}`;
        if (name) line += ` ${q(trunc(name, 120))}`;
        const attrs = [];
        const lvl = prop(node, 'level');
        if (lvl) attrs.push(`level=${lvl}`);
        for (const p of ['checked', 'pressed', 'selected', 'expanded']) {
          const v = prop(node, p);
          if (v !== undefined && v !== 'false' && v !== false) attrs.push(v === true || v === 'true' ? p : `${p}=${v}`);
        }
        if (prop(node, 'disabled')) attrs.push('disabled');
        if (node.backendDOMNodeId && (isInteractive || (REF_ROLES.has(role) && name))) {
          const ref = `e${++counter}`;
          refs[ref] = node.backendDOMNodeId;
          attrs.push(`ref=${ref}`);
        }
        if (attrs.length) line += ` [${attrs.join(', ')}]`;
        const value = node.value?.value;
        if (value !== undefined && value !== '' && value !== name) line += `: ${trunc(String(value), 120)}`;
      }
      lines.push((interactive ? '' : '  '.repeat(level)) + line);
      childLevel = level + 1;
    }
    for (const cid of node.childIds || []) {
      const c = byId.get(cid);
      if (c) walk(c, childLevel, show ? name : parentName, inField || FIELDS.has(role));
    }
  }

  walk(nodes[0], 0, '', false);
  await chrome.storage.session.set({ [`refs_${tabId}`]: refs });
  const t = await chrome.tabs.get(tabId);
  const header = `# ${t.title || ''}\n# ${t.url || ''}\n`;
  return { text: header + (lines.join('\n') || '(no elements)'), refs: counter };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const COMMANDS = {
  async tabs() {
    const { currentTab } = await chrome.storage.session.get('currentTab');
    const tabs = await chrome.tabs.query({});
    return tabs.map((t) => ({
      id: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url,
      current: t.id === currentTab,
    }));
  },

  async use({ tab }) {
    let id;
    if (tab === 'active') {
      const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!t) throw new Error('no active tab');
      id = t.id;
    } else {
      id = Number(tab);
      await chrome.tabs.get(id);
    }
    await chrome.storage.session.set({ currentTab: id });
    return tabInfo(id);
  },

  async open({ url, background, timeout_ms }) {
    const t = await chrome.tabs.create({ url, active: !background });
    await chrome.storage.session.set({ currentTab: t.id });
    await waitForTabComplete(t.id, timeout_ms || 30000);
    return tabInfo(t.id);
  },

  async goto({ url, timeout_ms }, tab) {
    const tabId = await resolveTab(tab);
    const done = waitForTabComplete(tabId, timeout_ms || 30000);
    await chrome.tabs.update(tabId, { url });
    await done;
    return tabInfo(tabId);
  },

  async back({ timeout_ms }, tab) {
    const tabId = await resolveTab(tab);
    await chrome.tabs.goBack(tabId);
    await settle(tabId);
    return tabInfo(tabId);
  },

  async forward({ timeout_ms }, tab) {
    const tabId = await resolveTab(tab);
    await chrome.tabs.goForward(tabId);
    await settle(tabId);
    return tabInfo(tabId);
  },

  async reload({ timeout_ms }, tab) {
    const tabId = await resolveTab(tab);
    const done = waitForTabComplete(tabId, timeout_ms || 30000);
    await chrome.tabs.reload(tabId);
    await done;
    return tabInfo(tabId);
  },

  async close({ id }, tab) {
    const tabId = id ?? (await resolveTab(tab));
    await chrome.tabs.remove(tabId);
    return null;
  },

  async snapshot(args, tab) {
    return snapshot(await resolveTab(tab), args);
  },

  async click({ target, double, right }, tab) {
    const tabId = await resolveTab(tab);
    const { x, y } = await centerOf(tabId, await resolveTarget(tabId, target));
    await mouseClick(tabId, x, y, { button: right ? 'right' : 'left', clickCount: double ? 2 : 1 });
    await settle(tabId);
    return null;
  },

  async hover({ target }, tab) {
    const tabId = await resolveTab(tab);
    const { x, y } = await centerOf(tabId, await resolveTarget(tabId, target));
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    return null;
  },

  async fill({ target, text }, tab) {
    const tabId = await resolveTab(tab);
    const obj = await resolveTarget(tabId, target);
    try { await cdp(tabId, 'DOM.scrollIntoViewIfNeeded', { objectId: obj }); } catch {}
    await callOn(tabId, obj, `function () {
      this.focus();
      if (typeof this.select === 'function') { this.select(); }
      else if (this.isContentEditable) {
        const sel = getSelection(); sel.removeAllRanges();
        const r = document.createRange(); r.selectNodeContents(this); sel.addRange(r);
      }
    }`);
    if (text) await cdp(tabId, 'Input.insertText', { text });
    else await pressKey(tabId, 'Delete');
    return null;
  },

  async type({ text, target }, tab) {
    const tabId = await resolveTab(tab);
    if (target) {
      const { x, y } = await centerOf(tabId, await resolveTarget(tabId, target));
      await mouseClick(tabId, x, y);
    }
    await typeText(tabId, text);
    return null;
  },

  async press({ key }, tab) {
    const tabId = await resolveTab(tab);
    await pressKey(tabId, key);
    await settle(tabId);
    return null;
  },

  async select({ target, value }, tab) {
    const tabId = await resolveTab(tab);
    const obj = await resolveTarget(tabId, target);
    return callOn(tabId, obj, `function (v) {
      if (this.tagName !== 'SELECT') throw new Error('element is not a <select>');
      const opt = [...this.options].find(o => o.value === v) ||
                  [...this.options].find(o => o.label.trim() === v || o.text.trim() === v);
      if (!opt) throw new Error('no option ' + JSON.stringify(v));
      this.value = opt.value;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return opt.value;
    }`, [value]);
  },

  async scroll({ direction, amount }, tab) {
    const tabId = await resolveTab(tab);
    const px = amount ?? 600;
    const d = { up: [0, -px], down: [0, px], left: [-px, 0], right: [px, 0] }[String(direction).toLowerCase()];
    if (!d) throw new Error('direction must be up|down|left|right');
    const { w, h } = await evaluate(tabId, '({ w: innerWidth, h: innerHeight })');
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: Math.floor(w / 2), y: Math.floor(h / 2), deltaX: d[0], deltaY: d[1],
    });
    await sleep(100);
    return null;
  },

  async scrollintoview({ target }, tab) {
    const tabId = await resolveTab(tab);
    await centerOf(tabId, await resolveTarget(tabId, target));
    return null;
  },

  async get({ what, target }, tab) {
    const tabId = await resolveTab(tab);
    if (what === 'title') return (await chrome.tabs.get(tabId)).title;
    if (what === 'url') return (await chrome.tabs.get(tabId)).url;
    const fns = {
      text: 'function () { return this.innerText ?? this.textContent; }',
      html: 'function () { return this.outerHTML; }',
      value: 'function () { return this.value; }',
    };
    if (!fns[what]) throw new Error('what must be text|html|value|title|url');
    const obj = target
      ? await resolveTarget(tabId, target)
      : (await cdp(tabId, 'Runtime.evaluate', { expression: what === 'html' ? 'document.documentElement' : 'document.body' })).result.objectId;
    return callOn(tabId, obj, fns[what]);
  },

  async eval({ expression }, tab) {
    return evaluate(await resolveTab(tab), expression);
  },

  async screenshot({ full }, tab) {
    const tabId = await resolveTab(tab);
    const params = { format: 'png' };
    if (full) {
      const m = await cdp(tabId, 'Page.getLayoutMetrics');
      const size = m.cssContentSize || m.contentSize;
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
    }
    const { data } = await cdp(tabId, 'Page.captureScreenshot', params);
    return { data };
  },

  async wait({ ms, target, text, url, load, timeout_ms }, tab) {
    if (ms != null) { await sleep(ms); return null; }
    const tabId = await resolveTab(tab);
    const deadline = Date.now() + (timeout_ms || 30000);
    let check;
    if (target) {
      check = async () => {
        try { await centerOf(tabId, await resolveTarget(tabId, target)); return true; } catch { return false; }
      };
    } else if (text != null) {
      check = async () => evaluate(tabId, `document.body?.innerText.includes(${q(text)})`);
    } else if (url != null) {
      check = async () => ((await chrome.tabs.get(tabId)).url || '').includes(url);
    } else {
      check = async () => (await chrome.tabs.get(tabId)).status === 'complete' &&
        (await evaluate(tabId, 'document.readyState')) === 'complete';
    }
    while (Date.now() < deadline) {
      try { if (await check()) return null; } catch {}
      await sleep(200);
    }
    throw new Error('wait timed out');
  },

  async detach(_, tab) {
    const tabId = await resolveTab(tab);
    try { await chrome.debugger.detach({ tabId }); } catch {}
    attached.delete(tabId);
    return null;
  },
};
