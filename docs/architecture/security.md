# Security and consent

How local processes, web pages and agents are kept away from tabs and secrets they weren't given.
Code: `cli/src/proxy.rs`, `cli/src/main.rs`, `extension/src/background/{connection,tabs,command,dispatch}.ts`.
The wire details are in [protocol.md](protocol.md).

## Rules

- **MUST** keep the mutual HMAC handshake: fresh nonces from both sides, role-bound MACs, constant-time verification, and the CLI and extension both verifying the server MAC. *Why:* while the proxy is down, any local process can bind the port. Without the server MAC, a squatter could collect commands or impersonate the proxy.
- **MUST** keep the Origin rule at WebSocket upgrade: no Origin → `cli` only; `chrome-extension://fekhggniifjffgnkljlblgfcoolaonbm` → `ext` only; any other Origin → 403. *Why:* web pages can open WebSockets to localhost.
- **MUST NOT** change the manifest `key` (it pins the extension ID). *Why:* the proxy accepts only that origin, and the managed folder already loaded in users' browsers carries it.
- **MUST** keep the secret off the wire and out of web-accessible resources. Store it with mode 0600 on Unix (`config.json`, `pairing.json`). *Why:* it is the only credential. Windows relies on the `%APPDATA%` ACLs (no explicit protection).
- **MUST** route every tab access through `Ctx.tab()` / `isControlled()`. Never call CDP on a tab id taken straight from argv. *Why:* this is the consent boundary.
- **MUST NOT** let `open <url>` navigate a shared tab. It opens an agent tab instead. *Why:* sharing a tab means "look and act here", not "replace my page".
- **MUST** redact user-typed text from the activity log. *Why:* agents type passwords and personal data. The popup and session storage are visible to anyone at the machine.

- **MUST** declare redaction next to the parser: `Command.show` / `showFlags` / `log` (`logArgs` in `command.ts`). By default a command logs only its first positional argument and no flag values; everything else is `•••`. A command opts in to showing more (`show: Infinity` for targets, URLs and key names; `showFlags` for flag values that are never user text). `find … <action> <value>` logs the locator and the action but not the value, `dialog accept <text>` logs no text, and `eval` logs only `eval (N chars)`. Arguments that do not parse log the command name alone. *Why:* a new command is safe without remembering anything.

## Consent model

- **Agent tab** (`control: 'agent'`): the agent opened it, or a controlled tab opened it (popup, OAuth window, `target=_blank`). These are intended: the flow the agent started continues in the new tab.
- **Shared tab** (`control: 'user'`): `tab <tN>` on an unshared tab calls `requestControl`. The popup opens, or a small window if Chrome isn't focused, and waits up to 120 s for Allow/Deny. The user can also share the current tab from the popup.
- Once a tab is controlled, the agent may do anything a command offers, including `tab close` on a shared tab. That is intended: approval grants full control of that tab.
- **Revoke**: popup Stop / Stop all, closing Chrome's debugging bar (`canceled_by_user` detach), or the session's `close` (closes agent tabs that session owns and releases the session's current tab if it is shared). Revoke clears control, owner and refs, and detaches the debugger.
- **MUST** end all control when the popup's on/off switch is turned off: revoke every grant and deny every pending approval (`revokeAll` in `index.ts`). *Why:* the switch is the user's emergency stop in their own browser. Turning it back on starts with no grants.
- Grants live in `chrome.storage.session`. They survive service-worker and proxy restarts and are carried over by a self-update handoff. Turning the switch off, disabling or reloading the extension in Chrome, and restarting the browser clear them.

- **MUST** answer or drop every pending approval: the waiter lives in memory only, so `loadState` never restores approvals (a restarted service worker starts with none, and the CLI request that asked has already failed with "browser extension disconnected"), and closing the tab rejects the waiter with "The tab was closed while waiting for the user to allow control" (`failApprovals` in `tabs.ts`). *Why:* an approval card with nothing behind it does nothing, and a CLI waiting for a closed tab would hang for 120 s.

## Network observation

`network requests` / `network request <id>` (`network.ts`, `commands/network.ts`) are read-only: they change no traffic and nothing in the profile. They still expose what page JS cannot read (`HttpOnly` cookies, `Authorization`), so:

- **MUST** redact credentials at ingestion, with no flag that reveals them: the headers `Cookie`, `Set-Cookie`, `Authorization`, `Proxy-Authorization`, `X-Api-Key`, `X-Csrf-Token`, `X-Xsrf-Token` and any header whose name looks like a token, secret, key, session, csrf/xsrf or `auth`; secret-like query values in URLs; `password`/`token`/`secret`/`api key`/`csrf`-like fields in JSON, urlencoded and multipart request bodies. *Why:* the buffer, `--json` output and the agent's context must never hold the user's session.
- **MUST** redact the obvious token fields (`access_token`, `refresh_token`, `id_token`, `token`, `secret`, `password`, `client_secret`, at any depth) of JSON response bodies before output. Other body content (HTML, free text, non-listed JSON keys) is returned as is: it is page content, like `get text`. *Why:* OAuth token endpoints answer with bearer tokens.
- **MUST** show text bodies only, capped at 32 KB; binary bodies are not returned. *Why:* size, and secrets in binary blobs cannot be redacted.
- **MUST** keep bodies out of the activity log: `network` logs `network requests` (with `--type/--method/--status` values) or `network request <id>`; `--filter` text is redacted.
- **MUST** use `ctx.tab()` (controlled tabs only), record lazily (`Network.enable` on the first `network` command per tab) and keep at most 500 entries per tab in memory. The buffer is dropped when the debugger session ends (`cdp.onDetached`: revoke, user detach, a navigation that swaps the renderer, tab close). *Why:* no recording on tabs the agent never asked about, and nothing survives a revoke.
- Not built: `network route`/`unroute` (interception) and `har` (would write whole bodies and headers to disk).

## Trust boundaries

- **The extension is trusted by the CLI.** The CLI writes `res.files[].path` without confining it. `upload` reads any path the CLI resolves. Anyone who can authenticate as `ext` can write files as the user, which is why the auth rules above are MUST.
- **The local filesystem is not a boundary.** `bctl` runs as the user, and the agent already has shell access. So `upload`, `screenshot <path>` and opening `file://` URLs are allowed, as in agent-browser. The consent boundary is the browser profile (tabs, sessions, logins), not files.
- **Page content is untrusted data.** Snapshots and text are passed through unchanged, and the skills tell agents not to follow instructions found in page content. `eval` runs arbitrary JS with a user gesture by design.
- **Blocked URLs:** navigation refuses `chrome*`, `edge*`, `brave*` and `about:` URLs (except `about:blank`). Chrome itself refuses to attach to its own pages and the Web Store.

## Gotchas

- A port squatter makes the CLI report "server authentication failed", not "port in use".
- `pairing.json` is read with `fetch(chrome.runtime.getURL(...), {cache: 'no-store'})` before every connection, so re-pairing needs no reload. It must stay non-web-accessible (no `web_accessible_resources` in the manifest).
- The development private key (`extension/key.pem`) is gitignored. It is only needed to pack a `.crx` or for a first Web Store upload with the same ID.

## Change risk

| Area | Risk | Required care |
|---|---|---|
| Handshake, Origin rule, manifest `key` | High | relay tests (`cli/tests/relay.rs` covers bad MAC, origin 403, role mismatch, fake server); user sign-off |
| Consent paths (`tabs.ts`, `Ctx.tab()`, opener grant, revoke) | High | manual approve/deny/revoke/debug-bar test; user sign-off for any widening |
| Activity-log content | Medium | check new commands with free-text args against `SECRET_ARGS` |
| File paths in `res.files` / `upload` | Medium | any new file-writing command is a security change |
