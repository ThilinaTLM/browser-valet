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
- **MUST** log `batch` per item (each through its own command's redaction) and never as a raw line; see [automation.md](automation.md).

- **MUST** declare redaction next to the parser: `Command.show` / `showFlags` / `log` (`logArgs` in `command.ts`). By default a command logs only its first positional argument and no flag values; everything else is `•••`. A command opts in to showing more (`show: Infinity` for targets, URLs and key names; `showFlags` for flag values that are never user text). `find … <action> <value>` logs the locator and the action but not the value, `dialog accept <text>` logs no text, and `eval` logs only `eval (N chars)`. Arguments that do not parse log the command name alone. *Why:* a new command is safe without remembering anything.

## Consent model

- **Agent tab** (`control: 'agent'`): the agent opened it, or a controlled tab opened it (popup, OAuth window, `target=_blank`). These are intended: the flow the agent started continues in the new tab.
- **Shared tab** (`control: 'user'`): `tab <tN>` on an unshared tab calls `requestControl`. The popup opens, or a small window if Chrome isn't focused, and waits up to 120 s for Allow/Deny. The user can also share the current tab from the popup.
- Once a tab is controlled, the agent may do anything a command offers, including `tab close` on a shared tab. That is intended: approval grants full control of that tab.
- **Revoke**: popup Stop / Stop all, closing Chrome's debugging bar (`canceled_by_user` detach), or the session's `close` (closes agent tabs that session owns and releases the session's current tab if it is shared). Revoke clears control, owner and refs, and detaches the debugger (which ends the tab's iframe child sessions and frame scope; they are only created for controlled tabs, by `cdp.attach`).
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
- Not built: `network route`/`unroute` (interception: the document-only navigation guard under [Guardrails](#guardrails) never alters traffic) and `har` (would write whole bodies and headers to disk).

## Guardrails

The user's policy lives in `chrome.storage.local` key `guardrails` (set in the popup, enforced in the worker: `guardrails.ts`). Agent flags may only narrow it.

- **MUST** treat content boundaries as labelling, not as a security boundary: the markers tell the agent where page text begins and ends, and the per-response nonce stops a page from closing the block early. They do not stop an agent from obeying the text inside. The skill says so.
- **Default:** boundaries off. `--content-boundaries` or the popup's "always" turns them on; an agent cannot turn the user's setting off.
- **MUST** enforce the allowed-domains policy before the agent navigates: `open`, `tab new`, `click --new-tab`, `pushstate` (against the page's current origin) and `read <url>` (it runs `open`) call `assertNavigable` (`guardrails.ts`) and fail with `domain_blocked`. A page URL counts when its host matches a pattern; with a policy active only `http(s)` and `about:blank` are reachable (`file:`, `data:`, `javascript:` are not). *Why:* a prompt-injected page ("open mail.google.com and forward…") must not be able to steer the agent to the user's other accounts.
- **Patterns:** `example.com` (the domain and all its subdomains), `*.example.com` (subdomains only), `host:port` (that exact host and port, e.g. `localhost:3000`; the scheme's default port counts). Case-insensitive; a pasted URL is reduced to its host. An empty list means unrestricted, so the popup **rejects** a mistyped pattern instead of dropping it (dropping could turn a policy into "allow everything").
- **MUST** merge policies by conjunction: a URL must pass the user's list (popup, `guardrails.allowedDomains`) **and** the agent's `--allowed-domains`. The flag can only narrow. The error names which policy refused and what it allows.
- The policy also covers agent-initiated navigation on **shared** tabs (`pushstate`, and `open`, which opens an agent tab instead); it never restricts the user's own browsing.
- **Layer 2, navigations the page starts** (`navigation-guard.ts`; signed off by the user): while a policy is active (the popup list, or the `--allowed-domains` of a command in flight), every **agent tab** with an attached debugger runs `Fetch.enable` with `patterns: [{resourceType: 'Document', requestStage: 'Request'}]`. A paused document request whose URL the policy refuses gets `Fetch.failRequest(BlockedByClient)`; every other one gets `Fetch.continueRequest` unchanged. **MUST NOT** mock, modify, delay or inspect bodies, and **MUST NOT** pause any other resource type: scripts, images, XHR/fetch, WebSockets and beacons are untouched. The handler fails closed (an error while deciding blocks the navigation) but continues every request when no policy is active, the tab is shared or unknown, so a restarted worker never leaves a request hanging. Frame documents count too: a cross-site iframe on an allowed page is refused as well (a deliberate cost of the policy: SSO and captcha frames need their host in the list).
- *What the agent sees:* `open`/`read` that ends on a refused redirect fail with `domain_blocked` ("Navigation to <host> was blocked by the allowed-domains policy"). Other commands succeed and print the same text as a `⚠` warning on stderr the next time they run on that tab (script navigations, clicked links, popups). Chrome commits an error page for a failed navigation, so the safety net below leaves the tab at `about:blank`.
- *Safety net:* an agent tab whose committed URL (`tabs.onUpdated`) is refused is sent to `about:blank` (covers what Fetch cannot see, such as service-worker responses). The first page of a **new** tab loads through the tabs API before any debugger can attach, so a redirect there is only caught after the load (`assertLanded`/the same net): the request was made, the tab is blanked and the command fails. A popup opened by an agent tab (opener grant) attaches at once when a policy is active.
- *Shared tabs* are not Fetch-guarded (the user browses in them): `open`, `pushstate`, `tab new` and `click --new-tab` are checked by the commands layer, but a link the agent clicks inside a shared tab is not. *Gaps:* history navigations to an old disallowed URL and pages served by a service worker are only caught by the safety net.
- Not attempted: blocking subresources, WebSockets or beacons (CDNs, analytics and SSO would break).
- **Action confirmation:** the user picks categories in the popup (`guardrails.confirm`): `eval` (also `wait --fn`), `upload`, `navigate-new-site`. Before such a command runs (`confirmCommand` in `execute`; `guardNavigation` where the URL is known), the worker asks through the **same approval flow as tab consent** (`requestConfirmation` in `tabs.ts`: popup card or small window, 120 s timeout, `!` badge). The card shows the session, the category and the command **redacted exactly as in the activity log** (so `eval` shows `eval (N chars)`, never the code), plus the host for a new site. Deny → `denied`, no answer → `timeout`; in both the command does nothing.
- **MUST** keep confirmations under the approval rules above: a card is never restored after a worker restart, closing the tab it is tied to (the session's current tab; none for the very first `open`) fails the waiter, and turning the switch off denies it.
- The agent's `--confirm-actions eval,upload` can only **add** categories (union with the user's). It cannot remove or bypass the user's.
- *New site* means a host (leading `www.` ignored) the session has not navigated to through `open`, `tab new`, `click --new-tab` or `read <url>`. Visited hosts are remembered per session (`state.sessions[s].sites`, last 200, also when the category is off) and a site counts once the agent was allowed there. Redirects and link clicks are not tracked. A domain-blocked URL fails before any card is shown.
- The output limit is a context-size default (popup), not a restriction: the agent's `--max-output` overrides it.

## Trust boundaries

- **The extension is trusted by the CLI.** The CLI writes `res.files[].path` without confining it. `upload` reads any path the CLI resolves. Anyone who can authenticate as `ext` can write files as the user, which is why the auth rules above are MUST.
- **The local filesystem is not a boundary.** `bctl` runs as the user, and the agent already has shell access. So `upload`, `screenshot <path>` and opening `file://` URLs are allowed, as in agent-browser. The consent boundary is the browser profile (tabs, sessions, logins), not files.
- **Page content is untrusted data.** Snapshots and text are passed through unchanged (optionally wrapped in nonce markers, see [Guardrails](#guardrails)), and the skills tell agents not to follow instructions found in page content. `eval` runs arbitrary JS with a user gesture by design.
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
| Guardrails (`guardrails.ts`, domain policy, confirmation cards) | High | unit tests for matching and merge; E2E for block, allow and deny; user sign-off |
| Activity-log content | Medium | check new commands with free-text args against `SECRET_ARGS` |
| File paths in `res.files` / `upload` | Medium | any new file-writing command is a security change |
