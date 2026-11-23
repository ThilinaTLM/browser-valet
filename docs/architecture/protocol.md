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
  `<data_dir>/browser-valet/extension/`, adding `pairing.json` (`{"secret": "...", "port": 47823}`,
  mode 0600). The user loads that folder as an unpacked extension. The extension fetches
  `chrome.runtime.getURL("pairing.json")` (`cache: no-store`) at startup and before every connection
  attempt, so re-pairing (`bvl setup`, `bvl pair`) needs no reload. If the file exists, it overrides
  the secret and port stored in the extension. The file is not web-accessible.
- **Manual (development builds loaded from `extension/dist`):** the extension generates the secret
  and shows a pairing command, `bvl pair <secret>`.

The CLI stores the secret in `<config_dir>/browser-valet/config.json`
(`{"secret": "...", "port": 47823}`; file mode 0600 on Unix). `config_dir` = `dirs::config_dir()`
(`~/.config` on Linux, `~/Library/Application Support` on macOS, `%APPDATA%` on Windows).
`data_dir` = `dirs::data_local_dir()` (`~/.local/share` on Linux, `~/Library/Application Support` on
macOS, `%LOCALAPPDATA%` on Windows). Full layout and overrides: [runtime.md](runtime.md#persisted-files-cli-side).
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
- The extension sends `{"t":"ping"}` every ~20 s to keep its service worker alive. They do **not** count as
  activity for the idle timer. The extension sends one only after an extension API call (`getPlatformInfo`) has
  returned.
- **Liveness.** A browser keeps the socket of a dead service worker open, so an open socket proves nothing.
  After a controlled tab is closed Chrome can leave the worker *wedged*: JavaScript, timers and the socket still
  work (the socket stays open) while every `chrome.*` call hangs. Some seconds later Chrome *terminates* it:
  the connection then ends with close code 1001 (going away) or with no close frame at all. The proxy
  therefore trusts only `ping`/`pong` frames, which the extension sends only after an extension API call has
  returned. A `res` or `event` proves nothing: a wedged worker can finish a request and hang on the next.
  - Before it answers `status` or forwards a `req` the proxy **always** sends `{"t":"ping"}` and waits up to
    `BVL_EXT_PROBE_MS` (default 2.5 s; `0` turns probing off) for a `ping` or `{"t":"pong"}` (a healthy worker
    answers in about a millisecond). A `req` probe waits four times as long while the extension has a request in
    flight (a worker busy with one may be slow); a `status` probe never does, so the reply stays well inside the
    CLI's 10 s read timeout. A synchronous CPU block of more than the probe wait during a concurrent `req` can
    therefore get a healthy connection dropped and fail the command that was in flight on it; commands avoid
    long synchronous work. The CLI's own version-check `status` and `setup`'s `ext_info` (update decision)
    carry `"probe":false` and skip the probe; their `ext` can therefore show a dead worker.
  - No answer: the proxy drops the connection (`bye` with reason `restart`, which a slow but live worker
    answers by reconnecting instead of switching itself off; a dead one never reads it), fails its pending
    requests with "browser extension disconnected" and records the loss (`unresponsive`). Exception: for a
    `status` while a request is in flight the proxy does not drop (that would fail the request), it only
    reports the extension as not connected.
  - It also drops an extension that sent no `ping`/`pong` for `BVL_EXT_SILENT_MS` (default 50 s; the extension
    pings every 20 s).
  - A connection that ends with close code 1001 or with no close frame is recorded as a loss too (`vanished`).
    The same happens when the browser quits or the extension is disabled, reloaded or removed, so a recorded
    loss does not prove the switch is on; the messages say to ask the user to switch it on in that case. One the
    extension closes itself (no code) is a switch-off, not a loss, and clears a recorded one.
  - A replacement connection that arrives while a probe waits is never dropped by that probe.
  - An extension whose `extVersion` differs from the bundled one (dev build, update in progress; without an embedded extension, from the bvl version) may predate `ping`: it is never probed (so never dropped for silence on a probe), only by the silence limit.
  A recorded loss is cleared when an extension connects and forgotten `BVL_EXT_WAKE_MS` (default 65 s) after it
  happened.
- A `req` that finds no extension waits `BVL_EXT_WAIT_MS` (default 10 s) for one. While a loss is recorded it
  waits until `BVL_EXT_WAKE_MS` after the loss instead, if that is later, and sends the CLI an `event`
  ("browser extension stopped responding; waiting for it to restart (up to N s) …"). A dead worker is wedged
  for up to ~30 s before Chrome ends it, then starts again on the next browser event or its 30 s alarm, and
  reconnects. If it does not come back the `res` says the worker stopped responding (`not_connected`). These
  waits, and the probe, come on top of the command's own `--timeout`. A loss older than `BVL_EXT_WAKE_MS` is
  ignored: the usual "not connected / switch it on" answer.
- Before it exits, the proxy sends the extension `{"t":"bye","reason":"idle"|"stop"|"restart"}` and
  closes the connection: `idle` on idle expiry, otherwise the `shutdown` reason. It waits up to 1 s
  for this to be written. The extension acts on `bye` only after `welcome`. Any authenticated
  connection that ends without `bye` `restart` switches the extension off (see
  [runtime.md](runtime.md#the-onoff-switch)), so `bye` is best effort: a crashed proxy sends none
  and the extension still switches off.

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

An extension of another version is not liveness-probed (it may not know `ping`), so a dead one is noticed only by the silence limit. The proxy never updates non-managed extensions; `bvl status` only reports their version mismatch.
## CLI requests

After `welcome`, the CLI sends exactly one message and waits:

- `{"t":"req","req":{...}}` — run a command in the browser.
- `{"t":"status"}` → proxy replies `{"t":"status","proxy":{"version":"…","pid":123,"port":47823,"idleTimeoutSecs":600,"pending":0},"ext":null | {"browser":"…","extVersion":"…","managed":true}}` (`ext` is the extension's auth `info`; the proxy first checks the extension is alive, see Liveness, so `ext` is `null` for a dead worker). `extLost` is `null`, or `{"reason":"unresponsive"|"vanished","ageSecs":0,"waitSecs":65}` while the proxy has lost an extension (`waitSecs`: how much longer a request would wait for it). A `status` that finds a busy extension unresponsive does not drop it and records nothing: it reports `ext: null` with `waitSecs` 0. The CLI's `status`, help and `doctor` print "its background worker stopped responding, retry shortly" instead of "switch it on" when `extLost` is set. The CLI may send `{"t":"status","probe":false}` to skip the liveness check.
- `{"t":"shutdown","reason":"restart"|"stop"}` (`reason` optional; missing or unknown = `stop`) → proxy fails all in-flight requests (each CLI gets a `res`, `exitCode` 1, "proxy is shutting down"), sends `cancel` for them to the extension, then `bye` with the reason, replies `{"t":"ok"}` and exits. The CLI sends `restart` when a new proxy follows at once (version restart, `pair`, `doctor --fix`) and `stop` for `bvl stop` and `unpair`. `pending` in `status` is the number of in-flight requests.

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
1. Probe the extension (see Liveness). If none is connected, wait up to 10 s for one (longer after a recorded loss, see above); if none, reply with a `res` whose
   `stderr` explains that the browser extension is not connected, that it is probably switched off,
   and that the agent should ask the user to switch it on in the popup (`exitCode` 1).
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

Handled by the CLI itself (never forwarded): `setup [--browser B] [--open] [--no-wait]`,
`skills [list | get <name> [--full] [--ref R] | path [name] | install [--dir D]]`,
`pair <secret> [--port N]`, `unpair`, `status`, `doctor [--json] [--quick] [--fix]`, `proxy [--idle-timeout S] [--port N]`
(foreground relay), `stop`, `version`/`--version`.
`bvl status` (text and `--json`) starts the proxy if needed and repeats the `status` message for up
to 2.5 s while `ext` is `null`, so an extension still reconnecting to a fresh proxy is reported.
Everything else is forwarded as a `req`.

Help never runs a command. `<local command> --help`/`-h` and `help <local command>` print that
command's help from the CLI. Top-level help (`bvl`, `help`, `--help`, `-h`, without `--json`) always
works and exits 0: the CLI prints its overview (`cli/src/help.rs`), then, if paired, starts the
proxy, waits up to 2.5 s for the extension in `status` and forwards `["help"]` as a normal `req`,
printing its `stdout` (the browser command list) below. If any step fails it prints why (not
paired, proxy unreachable, extension switched off) and points at `bvl skills get core --ref commands`.
`help <browser command>`, `<browser command> --help` and `--json` help are forwarded as a `req` (without the 2.5 s extension check); when not paired, text help fails locally with exit 1.

`doctor` runs these checks in order and prints ✓/!/✗ with a one-line fix: config (exists, secret,
mode 0600 on Unix), managed folder (`pairing.json` matches the config, the folder's `manifest.json` version matches the bundled
version), proxy (port reachable, handshake, version), extension (connected, version equals the
CLI's, browser version ≥ 127) and a round trip (`help` as a normal `req`, with latency). It reads
the extension's info from the proxy's `status` reply, so there is no extra message type. It exits 1
if any check fails (version mismatches only warn). `--json` prints `{version, ok, checks:[{name,
status: pass|warn|fail|skip|fixed, message, fix?}]}`. `--quick` skips the round trip and does not
start a proxy. `--fix` does only safe repairs: chmod 0600 on `config.json`, rewrite the managed
folder, restart an idle proxy (never one with pending requests) and retry a failed round trip once. It never re-pairs. Without
`--quick` it starts the proxy on demand, like every other command.

If the proxy is not reachable, the CLI starts `bvl proxy` detached (Unix: own process group;
Windows: `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`), logging to
`<state_dir>/browser-valet/proxy.log` (`~/.local/state` on Linux, the data dir elsewhere), then retries for up to 3 s.
