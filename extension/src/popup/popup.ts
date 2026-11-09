// Popup UI: connection status + pairing, consent requests, tab sharing, and recent activity.
// Renders from chrome.storage (written by the background worker); actions are messages to it.

import {
  CONFIRM_CATEGORIES,
  type ConfirmCategory,
  type ConnStatus,
  type Guardrails,
  type PopupMessage,
  type Settings,
  type State,
} from '../shared';

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

const app = byId('app');
const statusEl = byId('status');
const enabledEl = byId('enabled') as HTMLInputElement;
const isWindow = new URLSearchParams(location.search).has('window');
if (isWindow) document.body.classList.add('window');

const STATUS_TEXT: Record<ConnStatus, string> = {
  connected: 'Connected',
  waiting: 'Idle',
  'auth-failed': 'Pairing mismatch',
  off: 'Off',
};

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

function send(msg: PopupMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}

function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function tabRow(t: chrome.tabs.Tab | undefined, tid: string, sub: string, actions: string) {
  const icon = t?.favIconUrl?.startsWith('http')
    ? `<img src="${esc(t.favIconUrl)}" alt="" />`
    : '<span class="noicon"></span>';
  return `<div class="tab">${icon}
    <div class="grow">
      <div class="title">${esc(t?.title ?? '(closed)')}</div>
      <div class="small muted">${tid ? `<span class="tid">${esc(tid)}</span> · ` : ''}${sub}</div>
    </div>${actions}</div>`;
}

let guardrailsOpen = false;

const CONFIRM_LABEL: Record<ConfirmCategory, string> = {
  eval: 'eval (JavaScript in a page)',
  upload: 'upload (local files leave the machine)',
  'navigate-new-site': 'navigating to a new site',
};
const CONFIRM_TITLE: Record<ConfirmCategory, string> = {
  eval: 'Run JavaScript in a page',
  upload: 'Upload local files',
  'navigate-new-site': 'Open a site it has not visited yet',
};

async function render(): Promise<void> {
  const { state } = await chrome.storage.session.get<{ state?: State }>('state');
  const settings = await chrome.storage.local.get<Partial<Settings>>(['secret', 'port', 'enabled']);
  const stored = await chrome.storage.local.get<{ guardrails?: Partial<Guardrails> }>('guardrails');
  const policy: Guardrails = {
    maxOutput: 0,
    contentBoundaries: false,
    allowedDomains: [],
    confirm: [],
    ...stored.guardrails,
  };
  // Do not rebuild the page under a field the user is typing in.
  if (document.activeElement?.closest('#guardrails')) return;
  if (!state) {
    app.innerHTML = '<p class="muted">Starting…</p>';
    return;
  }
  const tabs = new Map((await chrome.tabs.query({})).map((t) => [t.id, t]));
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const status = state.conn.status;

  statusEl.textContent =
    status === 'waiting' && !state.conn.paired ? 'Not paired' : STATUS_TEXT[status];
  statusEl.className = `pill ${status}`;
  enabledEl.checked = settings.enabled !== false;

  const parts: string[] = [];

  // 1. Consent requests come first: they block an agent that is waiting.
  for (const a of state.approvals) {
    const t = tabs.get(a.tabId);
    if (a.action) {
      const tab = t ? tabRow(t, state.tabs[a.tabId]?.tid ?? '', esc(t.url ?? ''), '') : '';
      parts.push(`<section class="card alert">
      <h2>Confirm action</h2>
      <p>An agent (session <b>${esc(a.session)}</b>) wants to: <b>${esc(CONFIRM_TITLE[a.action.category])}</b></p>
      ${a.action.site ? `<p>Site: <b>${esc(a.action.site)}</b></p>` : ''}
      <div class="code"><span>${esc(a.action.command)}</span></div>${tab}
      <p class="small muted">Arguments are hidden here, as in the activity log. Deny to stop it.</p>
      <div class="actions">
        <button data-action="deny" data-id="${a.id}">Deny</button>
        <button class="primary" data-action="allow" data-id="${a.id}">Allow</button>
      </div>
    </section>`);
      continue;
    }
    parts.push(`<section class="card alert">
      <h2>Permission request</h2>
      <p>An agent (session <b>${esc(a.session)}</b>) wants to control this tab:</p>
      ${tabRow(t, state.tabs[a.tabId]?.tid ?? '', esc(t?.url ?? ''), '')}
      <p class="small muted">It will be able to read the page and click/type in it until you stop it.</p>
      <div class="actions">
        <button data-action="deny" data-id="${a.id}">Deny</button>
        <button class="primary" data-action="allow" data-id="${a.id}">Allow</button>
      </div>
    </section>`);
  }

  // 2. Pairing / connection help.
  const pairCmd = `bctl pair ${settings.secret ?? ''}${
    settings.port && settings.port !== 47823 ? ` --port ${settings.port}` : ''
  }`;
  const pairBox = `<div class="code"><span>${esc(pairCmd)}</span>
    <button data-action="copy" data-text="${esc(pairCmd)}">Copy</button></div>`;
  const managed = state.conn.managed === true;
  if (managed) {
    if (status === 'auth-failed') {
      parts.push(`<section class="card alert"><h2>Pairing mismatch</h2>
        <p>The pairing file is out of date. Run this in a terminal:</p>
        <div class="code"><span>bctl setup</span>
        <button data-action="copy" data-text="bctl setup">Copy</button></div></section>`);
    } else if (status !== 'connected') {
      parts.push(`<section class="card"><h2>Paired automatically by bctl</h2>
        <p class="small muted">Run any <code>bctl</code> command; this connects on its own.</p></section>`);
    }
  } else if (status === 'auth-failed') {
    parts.push(`<section class="card alert"><h2>Pairing mismatch</h2>
      <p>The CLI is using a different pairing code. Run this in a terminal:</p>${pairBox}</section>`);
  } else if (!state.conn.paired && status !== 'off') {
    parts.push(`<section class="card"><h2>Connect the CLI</h2><ol>
      <li>Easiest: install via <code>bctl setup</code>, which pairs automatically.</li>
      <li>Or pair manually. Run in a terminal:${pairBox}</li>
      <li>Run <code>bctl status</code>. This turns green when connected.</li></ol></section>`);
  }

  // 3. The tab the user is looking at.
  if (active?.id !== undefined && !isWindow) {
    const m = state.tabs[active.id];
    const controlled = m?.control !== undefined;
    const restricted = !/^(https?|file|about|data):/.test(active.url ?? '');
    const action = controlled
      ? `<button class="danger" data-action="revoke" data-tab="${active.id}">Stop</button>`
      : restricted
        ? ''
        : `<button data-action="share" data-tab="${active.id}">Share</button>`;
    const sub = controlled
      ? 'agent can control'
      : restricted
        ? 'browser page, cannot be shared'
        : 'not shared';
    parts.push(`<section class="card"><h2>This tab</h2>
      ${tabRow(active, m?.tid ?? '', sub, action)}</section>`);
  }

  // 4. Everything the agent currently controls.
  const controlled = Object.entries(state.tabs).filter(([, m]) => m.control);
  if (controlled.length) {
    const rows = controlled
      .map(([id, m]) => {
        const sub =
          m.control === 'agent' ? `opened by agent · ${esc(m.owner ?? '')}` : 'shared by you';
        return tabRow(
          tabs.get(Number(id)),
          m.tid + (m.label ? ` (${m.label})` : ''),
          sub,
          `<button class="danger" data-action="revoke" data-tab="${id}">Stop</button>`,
        );
      })
      .join('');
    parts.push(`<section class="card"><h2>Agent tabs
      <button class="link" data-action="revokeAll">Stop all</button></h2>${rows}</section>`);
  }

  // 5. Recent activity.
  if (state.log.length) {
    const items = state.log
      .slice(0, 8)
      .map(
        (
          l,
        ) => `<li title="${esc(l.error ?? '')}"><span class="${l.ok ? 'ok' : 'bad'}">${l.ok ? '✓' : '✗'}</span>
          <span class="cmd">${esc(l.command)}</span>
          <span class="tid">${esc(l.tid ?? '')}</span><span class="muted small">${ago(l.ts)}</span></li>`,
      )
      .join('');
    parts.push(
      `<section class="card"><h2>Recent activity</h2><ul class="log">${items}</ul></section>`,
    );
  }

  // 6. Guardrails: the user's policy for agents (enforced by the worker).
  if (!isWindow) {
    parts.push(`<details id="guardrails"${guardrailsOpen ? ' open' : ''}><summary>Guardrails</summary>
      <label class="field"><span>Allowed domains for agent navigation (one per line; empty = any)</span>
        <textarea id="g-domains" rows="3" spellcheck="false" placeholder="example.com&#10;*.example.com&#10;localhost:3000">${esc(policy.allowedDomains.join('\n'))}</textarea></label>
      <label class="check"><input id="g-boundaries" type="checkbox"${policy.contentBoundaries ? ' checked' : ''} />
        Always mark page content in output</label>
      <label class="field"><span>Default output limit (characters, 0 = none)</span>
        <input id="g-max" type="number" min="0" step="1000" value="${policy.maxOutput}" /></label>
      <p class="small muted">Ask me before the agent runs:</p>
      ${CONFIRM_CATEGORIES.map(
        (c) =>
          `<label class="check"><input type="checkbox" data-confirm="${c}"${policy.confirm.includes(c) ? ' checked' : ''} /> ${esc(CONFIRM_LABEL[c])}</label>`,
      ).join('')}
      <div class="actions"><button class="primary" data-action="guardrails">Save</button></div>
    </details>`);
  }

  // 7. Settings.
  if (!isWindow) {
    parts.push(`<details><summary>Settings</summary>
      <div class="row"><span class="grow">Port</span>
        <input id="port" type="number" min="1" max="65535" value="${managed ? (state.conn.port ?? 47823) : (settings.port ?? 47823)}"${managed ? ' disabled' : ''} />
        <button data-action="port"${managed ? ' disabled' : ''}>Save</button></div>
      ${
        managed
          ? '<p class="small muted" style="margin-top:8px">The port comes from bctl (re-run <code>bctl setup</code> to change it).</p>'
          : `<p class="small muted" style="margin-top:8px">Pairing command:</p>${pairBox}
      <div class="actions"><button class="danger" data-action="repair">New pairing code</button></div>`
      }
    </details>`);
  }

  app.innerHTML = parts.join('');
  if (isWindow && state.approvals.length === 0) window.close();
}

app.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!el) return;
  const { action, id, tab, text } = el.dataset;
  const tabId = Number(tab);
  switch (action) {
    case 'allow':
    case 'deny':
      if (id) void send({ type: 'decide', id, allow: action === 'allow' });
      break;
    case 'share':
      void send({ type: 'share', tabId });
      break;
    case 'revoke':
      void send({ type: 'revoke', tabId });
      break;
    case 'revokeAll':
      void send({ type: 'revokeAll' });
      break;
    case 'copy':
      void navigator.clipboard.writeText(text ?? '').then(() => {
        el.textContent = 'Copied';
        setTimeout(() => (el.textContent = 'Copy'), 1500);
      });
      break;
    case 'port': {
      const port = Number((document.getElementById('port') as HTMLInputElement).value);
      if (port > 0 && port < 65536) void send({ type: 'settings', settings: { port } });
      break;
    }
    case 'guardrails': {
      const max = Number((document.getElementById('g-max') as HTMLInputElement).value);
      void send({
        type: 'guardrails',
        guardrails: {
          maxOutput: Number.isInteger(max) && max > 0 ? max : 0,
          allowedDomains: (document.getElementById('g-domains') as HTMLTextAreaElement).value
            .split(/[\s,]+/)
            .filter(Boolean),
          confirm: [...document.querySelectorAll<HTMLInputElement>('[data-confirm]')]
            .filter((i) => i.checked)
            .map((i) => i.dataset.confirm as ConfirmCategory),
          contentBoundaries: (document.getElementById('g-boundaries') as HTMLInputElement).checked,
        },
      }).then((res) => {
        const r = res as { ok: boolean; error?: string };
        el.textContent = r.ok ? 'Saved' : 'Not saved';
        if (!r.ok) alert(r.error?.replace(/^Error: /, '') ?? 'Could not save');
        setTimeout(() => (el.textContent = 'Save'), 1500);
      });
      break;
    }
    case 'repair':
      if (confirm('Generate a new pairing code? The CLI must be paired again.')) {
        void send({ type: 'repair' });
      }
      break;
  }
});

app.addEventListener(
  'toggle',
  (ev) => {
    if ((ev.target as HTMLElement).id === 'guardrails') {
      guardrailsOpen = (ev.target as HTMLDetailsElement).open;
    }
  },
  true,
);

enabledEl.addEventListener('change', () => {
  void send({ type: 'settings', settings: { enabled: enabledEl.checked } });
});

chrome.storage.onChanged.addListener(() => void render());
chrome.tabs.onActivated.addListener(() => void render());
void send({ type: 'ping' }).then(() => render());
void render();
