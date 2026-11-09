# Browser Valet wire protocol (v1)

Contract between CLI, proxy and extension. Rules and change risk: [security.md](security.md),
[runtime.md](runtime.md). Proxy tests: `cli/tests/relay.rs`.

Three parties:

- **CLI** (`bvl …`) — thin client. Sends raw argv, prints what comes back.
- **Proxy** (`bvl proxy`, same binary) — stateless relay on `127.0.0.1`. Auto-started by the CLI,
  exits after an idle period.
- **Extension** — the source of truth. Parses argv, runs commands, owns all state, formats output.

All messages are JSON text frames over one WebSocket endpoint: `ws://127.0.0.1:<port>/`
(default port `47823`, override with env `BVL_PORT`).

## Pairing secret

The secret is 32 random bytes, base64url-encoded with no padding. There are two ways to share it:

- **Managed (default):** `bvl setup` generates the secret and writes the bundled extension to
  `<config_dir>/browser-valet/extension/`, adding `pairing.json` (`{"secret": "...", "port": 47823}`,
  mode 0600). The user loads that folder as an unpacked extension. The extension fetches
  `chrome.runtime.getURL("pairing.json")` (`cache: no-store`) at startup and before every connection
  attempt, so re-pairing (`bvl setup`, `bvl pair`) needs no reload. If the file exists, it overrides
  the secret and port stored in the extension. The file is not web-accessible.
- **Manual (development builds loaded from `extension/dist`):** the extension generates the secret
  and shows a pairing command, `bvl pair <secret>`.

The CLI stores the secret in `<config_dir>/browser-valet/config.json`
(`{"secret": "...", "port": 47823}`; file mode 0600 on Unix). `config_dir` = `dirs::config_dir()`
(`~/.config` on Linux, `~/Library/Application Support` on macOS, `%APPDATA%` on Windows).
The proxy reads the secret from the same file at startup. The secret is never sent on the wire.

HMAC key = UTF-8 bytes of the secret string. MAC = lowercase hex of HMAC-SHA256.

## Connection + mutual authentication (both roles)

Origin rule (checked at WebSocket upgrade):
- `Origin` header absent → only role `cli` is allowed.
- `Origin` is `chrome-extension://fekhggniifjffgnkljlblgfcoolaonbm` → only role `ext` is allowed.
  This ID is pinned by the `key` in the extension manifest.
- Any other `Origin` (web pages, other extensions) → reject with HTTP 403.

The `bctl1` HMAC label below predates the rename to Browser Valet / `bvl` and is intentionally kept: it is a protocol tag, not branding.

Handshake:

1. Proxy → client: `{"t":"challenge","nonce":"<Np>"}` (Np = 32 random bytes, hex)
2. Client → proxy: `{"t":"auth","role":"cli"|"ext","nonce":"<Nc>","mac":"<HMAC(key, "bctl1|client|" + role + "|" + Np + "|" + Nc)>","version":"<client version>","info":{...optional}}`
3. Proxy verifies (constant-time). On failure: `{"t":"error","error":"authentication failed (re-pair with `bvl pair`)"}` then close.
   On success: `{"t":"welcome","mac":"<HMAC(key, "bctl1|server|" + role + "|" + Nc + "|" + Np)>","version":"<proxy version>"}`
4. Client verifies the server MAC and closes the connection if it is wrong (protects against
   another process squatting the port while the proxy is down).
5. If the proxy's `version` differs from the CLI's, the CLI sends `status`. With no pending requests it sends `shutdown`, starts a proxy from its
   own binary and reconnects once, so an upgraded binary never talks to an old proxy. With pending requests it fails with an error instead of restarting.

Any message other than `auth` before authentication → close.

## Extension connection

- Only one extension connection is active. A newly authenticated `ext` replaces the old one
  (the old socket is closed).
- `info` in the ext auth message: `{"browser": "Google Chrome 157", "extVersion": "0.1.0", "managed": true}`
  (`managed` = `pairing.json` was found, so the extension runs from the folder `bvl` manages).
- The extension sends `{"t":"ping"}` every ~20 s to keep its service worker alive. The proxy ignores pings
  (they do **not** count as activity for the idle timer).

### Updates

The proxy acts when an extension authenticates with `managed: true`, its `extVersion` differs from
the version embedded in the binary, and the binary embeds an extension:

1. The proxy rewrites the managed folder: the embedded files, a fresh `pairing.json`, and stale
   files removed.
2. It sends `{"t":"update","version":"<embedded version>"}`.

The extension then:

1. Waits until no requests are in flight (at most 120 s; then it reloads anyway and drops them).
2. Copies its session state to `chrome.storage.local` (`handoff`), because a reload clears
   `chrome.storage.session`.
3. Calls `chrome.runtime.reload()`. Chrome re-reads the folder and the extension restores the
   handoff state (if under 60 s old) and reconnects.

Loop guard: the extension records the target version and time (`updateTried`). If it is still
running a different version, it ignores another update to the same version for 10 minutes.

The proxy never updates non-managed extensions; `bvl status` only reports their version mismatch.
## CLI requests

After `welcome`, the CLI sends exactly one message and waits:

- `{"t":"req","req":{...}}` — run a command in the browser.
- `{"t":"status"}` → proxy replies `{"t":"status","proxy":{"version":"…","pid":123,"port":47823,"idleTimeoutSecs":600,"pending":0},"ext":null | {"browser":"…","extVersion":"…","managed":true}}` (`ext` is the extension's auth `info`)
- `{"t":"shutdown"}` → proxy fails all in-flight requests (each CLI gets a `res`, `exitCode` 1, "proxy is shutting down"), sends `cancel` for them to the extension, replies `{"t":"ok"}` and exits. `pending` in `status` is the number of in-flight requests.

`req` object (opaque to the proxy):

```json
{
  "argv": ["snapshot", "-i"],          // everything after `bvl`
  "cwd": "/home/me/project",           // absolute
  "tmp": "/tmp",                       // absolute temp dir (std::env::temp_dir)
  "sep": "/",                          // path separator ("\\" on Windows)
  "platform": "linux",                 // linux | macos | windows
  "session": "default",                // from env BVL_SESSION, else "default"
  "stdin": "…"                         // only when argv contains "--stdin": all of stdin as UTF-8
}
```

Proxy behaviour for `req`:
1. If no extension is connected, wait up to 10 s for one; if none, reply with a `res` whose
   `stderr` explains that the browser extension is not connected, `exitCode` 1.
2. Assign a unique numeric `id`, forward `{"t":"req","id":<id>,"req":{...}}` to the extension.
3. Forward extension messages with that id back to the CLI **without the id**:
   - `{"t":"event","id":<id>,"stderr":"text"}` → `{"t":"event","stderr":"text"}` (progress, e.g. "waiting for approval…"; CLI prints to stderr immediately)
   - `{"t":"res","id":<id>,"res":{...}}` → `{"t":"res","res":{...}}` (final)
4. If the extension disconnects before answering → `res` with `stderr` "browser extension disconnected", `exitCode` 1.
5. Whenever the request ends without a final `res` from the extension (CLI disconnects, a write to the CLI fails) → send `{"t":"cancel","id":<id>}` to the extension and forget it.

Each `req` counts as activity for the idle timer (default 600 s, `BVL_IDLE_TIMEOUT` seconds or
`bvl proxy --idle-timeout <secs>`; `0` disables). The idle timer is not reset while a request is in
flight. On idle expiry the proxy exits.

`res` object (produced by the extension; the CLI just executes it):

```json
{
  "exitCode": 0,
  "stdout": "✓ Done\n",        // printed verbatim to stdout (may be empty)
  "stderr": "",                // printed verbatim to stderr
  "files": [                   // written by the CLI before printing (the extension always sends it, often [])
    { "path": "/abs/path/screenshot.png", "base64": "iVBOR…" }
  ]
}
```

A `res` the proxy generates itself (extension not connected or disconnected, proxy shutting down)
also carries `"code": "not_connected"` and an empty `stdout`. With `--json` in argv the CLI turns it
into the usual `{success:false,data:null,error,code}` envelope on stdout, so JSON mode stays
parseable. The CLI does the same for its own failures before a `res` exists (cannot reach the proxy,
authentication failed: `not_connected`; not paired: `not_paired`). Codes are listed in
[automation.md](automation.md#output-conventions).

The CLI creates parent directories for `files[].path` as needed.

## CLI-local commands

Handled by the CLI itself (never forwarded): `setup [--browser B] [--no-open] [--no-wait]`,
`skills [list | get <name> [--full] [--ref R] | path [name] | install [--dir D]]`,
`pair <secret> [--port N]`, `unpair`, `status`, `doctor [--json] [--quick] [--fix]`, `proxy [--idle-timeout S] [--port N]`
(foreground relay), `stop`, `version`/`--version`.
Everything else (including `help` / `--help`) is forwarded as a `req`.

`doctor` runs these checks in order and prints ✓/!/✗ with a one-line fix: config (exists, secret,
mode 0600 on Unix), managed folder (`pairing.json` matches the config, files match the bundled
version), proxy (port reachable, handshake, version), extension (connected, version equals the
CLI's, browser version ≥ 127) and a round trip (`help` as a normal `req`, with latency). It reads
the extension's info from the proxy's `status` reply, so there is no extra message type. It exits 1
if any check fails (version mismatches only warn). `--json` prints `{version, ok, checks:[{name,
status: pass|warn|fail|skip|fixed, message, fix?}]}`. `--quick` skips the round trip and does not
start a proxy. `--fix` does only safe repairs: chmod 0600 on `config.json`, rewrite the managed
folder, restart an idle proxy (never one with pending requests). It never re-pairs. Without
`--quick` it starts the proxy on demand, like every other command.

If the proxy is not reachable, the CLI starts `bvl proxy` detached (Unix: own process group;
Windows: `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`), logging to
`<config_dir>/browser-valet/proxy.log`, then retries for up to 3 s.
