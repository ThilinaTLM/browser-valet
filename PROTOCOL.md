# Browser Bridge wire protocol (v1)

Three parties:

- **CLI** (`bctl …`) — thin client. Sends raw argv, prints what comes back.
- **Proxy** (`bctl proxy`, same binary) — stateless relay on `127.0.0.1`. Auto-started by the CLI,
  exits after an idle period.
- **Extension** — the source of truth. Parses argv, runs commands, owns all state, formats output.

All messages are JSON text frames over one WebSocket endpoint: `ws://127.0.0.1:<port>/`
(default port `47823`, override with env `BCTL_PORT`).

## Pairing secret

The extension generates the secret (32 random bytes, base64url, no padding) and shows a pairing
command: `bctl pair <secret>`. The CLI stores it in `<config_dir>/browser-bridge/config.json`
(`{"secret": "...", "port": 47823}`; file mode 0600 on Unix). `config_dir` = `dirs::config_dir()`
(`~/.config` on Linux, `~/Library/Application Support` on macOS, `%APPDATA%` on Windows).
The proxy reads the secret from the same file at startup. The secret is never sent on the wire.

HMAC key = UTF-8 bytes of the secret string. MAC = lowercase hex of HMAC-SHA256.

## Connection + mutual authentication (both roles)

Origin rule (checked at WebSocket upgrade):
- `Origin` header absent → only role `cli` is allowed.
- `Origin` starts with `chrome-extension://` → only role `ext` is allowed.
- Any other `Origin` (web pages) → reject with HTTP 403.

Handshake:

1. Proxy → client: `{"t":"challenge","nonce":"<Np>"}` (Np = 32 random bytes, hex)
2. Client → proxy: `{"t":"auth","role":"cli"|"ext","nonce":"<Nc>","mac":"<HMAC(key, "bctl1|client|" + role + "|" + Np + "|" + Nc)>","version":"<client version>","info":{...optional}}`
3. Proxy verifies (constant-time). On failure: `{"t":"error","error":"authentication failed (re-pair with `bctl pair`)"}` then close.
   On success: `{"t":"welcome","mac":"<HMAC(key, "bctl1|server|" + role + "|" + Nc + "|" + Np)>","version":"<proxy version>"}`
4. Client verifies the server MAC and closes the connection if it is wrong (protects against
   another process squatting the port while the proxy is down).

Any message other than `auth` before authentication → close.

## Extension connection

- Only one extension connection is active. A newly authenticated `ext` replaces the old one
  (the old socket is closed).
- `info` in the ext auth message: `{"browser": "Google Chrome 157", "extVersion": "0.2.0"}`.
- The extension sends `{"t":"ping"}` every ~20 s to keep its service worker alive. The proxy ignores pings
  (they do **not** count as activity for the idle timer).

## CLI requests

After `welcome`, the CLI sends exactly one message and waits:

- `{"t":"req","req":{...}}` — run a command in the browser.
- `{"t":"status"}` → proxy replies `{"t":"status","proxy":{"version":"…","pid":123,"port":47823,"idleTimeoutSecs":600},"ext":null | {"browser":"…","extVersion":"…"}}`
- `{"t":"shutdown"}` → proxy replies `{"t":"ok"}` and exits.

`req` object (opaque to the proxy):

```json
{
  "argv": ["snapshot", "-i"],          // everything after `bctl`
  "cwd": "/home/me/project",           // absolute
  "tmp": "/tmp",                       // absolute temp dir (std::env::temp_dir)
  "sep": "/",                          // path separator ("\\" on Windows)
  "platform": "linux",                 // linux | macos | windows
  "session": "default",                // from env BCTL_SESSION, else "default"
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
5. If the CLI disconnects first → send `{"t":"cancel","id":<id>}` to the extension and forget it.

Each `req` counts as activity for the idle timer (default 600 s, `BCTL_IDLE_TIMEOUT` seconds or
`bctl proxy --idle-timeout <secs>`; `0` disables). The idle timer is not reset while a request is in
flight. On idle expiry the proxy exits.

`res` object (produced by the extension; the CLI just executes it):

```json
{
  "exitCode": 0,
  "stdout": "✓ Done\n",        // printed verbatim to stdout (may be empty)
  "stderr": "",                // printed verbatim to stderr
  "files": [                   // optional: written by the CLI before printing
    { "path": "/abs/path/screenshot.png", "base64": "iVBOR…" }
  ]
}
```

The CLI creates parent directories for `files[].path` as needed.

## CLI-local commands

Handled by the CLI itself (never forwarded): `pair <secret> [--port N]`, `unpair`, `status`,
`proxy [--idle-timeout S] [--port N]` (foreground relay), `stop`, `version`/`--version`.
Everything else (including `help` / `--help`) is forwarded as a `req`.

If the proxy is not reachable, the CLI starts `bctl proxy` detached (Unix: own process group;
Windows: `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`), logging to
`<config_dir>/browser-bridge/proxy.log`, then retries for up to 3 s.
