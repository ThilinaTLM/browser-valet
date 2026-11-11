# Runtime, state and updates

Process lifetimes, where state lives, persisted files, and the self-update flow. Code:
`cli/src/{main,proxy,embed}.rs` and `extension/src/background/{state,connection,index}.ts`.
Message formats: [protocol.md](protocol.md).

## Rules

- **MUST** keep the proxy free of durable state. Its memory holds only the extension connection, pending requests and the idle clock. *Why:* the CLI starts it on demand and it exits when idle. Anything stored there would be lost silently.
- **MUST** keep the managed folder path (`<data>/browser-valet/extension`) and the `config.json` / `pairing.json` keys (`secret`, `port`) stable once released. *Why:* the user picked that folder once in Load unpacked. Moving it or renaming keys strands every install. (It moved from `<config>` to `<data>` before the first release.)
- **MUST** auto-update only managed extensions, and only when the binary embeds an extension of a different version. *Why:* a dev build loaded from `extension/dist` must never be overwritten. `bvl status` only reports its mismatch.
- **Default:** new fields in the extension's `State` must have a default in `initial()`. *Why:* stored and handed-off state is spread over `initial()`, so state from an older version lacks the field.
- **Default:** `State.sessions[s].sites` (hosts the session has visited, for `navigate-new-site`) and `Approval.action` are optional; code treats a missing value as empty/none, so state from an older version still loads.
- **Default:** the user's guardrail policy (`guardrails` in `chrome.storage.local`: `maxOutput`, `contentBoundaries`, `allowedDomains`, `confirm`) is read by `loadGuardrails` through `sanitize`, so a missing or malformed key falls back to `DEFAULT_GUARDRAILS` (everything off). It is not part of `State`, so it is untouched by handoff and by revoke. *Why:* it is the user's setting, not session state; turning the switch off must not erase it.
- **Default:** one extension connection at a time; the newest authenticated one replaces the old one. The replaced extension sees its connection end without a `bye` and switches itself off.

## The on/off switch

`settings.enabled` (`chrome.storage.local` `enabled`) is the popup's switch. Code: `switch.ts` (`setEnabled`, `revokeAll`, `refreshIcon`), `connection.ts` (`onclose`), `state.ts` (`loadState`).

| Event | Switch |
|---|---|
| First install, browser start, extension reloaded or re-enabled in Chrome (no `chrome.storage.session` `state` and no handoff) | forced **off** in `loadState` |
| Service-worker restart (session `state` exists), self-update reload (handoff restored) | unchanged |
| Authenticated connection ends after `bye` `idle` / `stop`, or with no `bye` (proxy crashed or was killed, or another extension replaced this one) | **off**, `conn.offReason` = `idle` / `stopped` / `lost` |
| Connection ends after `bye` `restart` (CLI version restart, `bvl pair`, `doctor --fix`) | unchanged; reconnects |
| The extension closes the socket itself (`disconnect()`), or is reloading for a self-update | unchanged |
| Never authenticated (no proxy listening, auth failed) | unchanged; keeps retrying |
| User flips the switch | as set; switching on clears `offReason` |

- **MUST** go through `setEnabled` for every change: it persists `enabled`, revokes all control when switching off, records `offReason` and updates the toolbar icon and title. *Why:* manual and automatic off must behave the same (see [security.md](security.md#consent-model)).
- **MUST NOT** switch on from anything but the popup's `settings` message. *Why:* switching on is the user's decision.
- The toolbar icon is the grey `icons/icon-off-*.png` while off. The manifest's `default_icon` is the off icon, so the icon is right before the worker runs; `refreshIcon` sets the normal one when on.
- A killed service worker runs no `onclose`, so it stays on and reconnects. The 20 s keep-alive makes this rare.

## Lifetimes

| Process / store | Lifetime | Survives |
|---|---|---|
| CLI | one command | — |
| Proxy | started detached by the CLI on demand. Exits after `BVL_IDLE_TIMEOUT` (default 600 s, `0` = never) with no requests in flight. Pings don't count as activity. Before exiting it sends the extension `bye` (`idle`, or the `shutdown` reason), which switches the extension off unless it is `restart`. | nothing; it holds no durable state |
| Extension service worker | killed by Chrome when idle. The 20 s keep-alive ping and a 30 s alarm limit this. | `chrome.storage.session` |
| `chrome.storage.session` `state` (tabs, grants, sessions, refs, iframe sessions, frame scope, approvals, log) | until the extension is reloaded or disabled, or the browser restarts | SW and proxy restarts; self-update (via handoff) |
| `chrome.storage.local` (`secret`, `port`, `enabled`, `paired`, `handoff`, `updateTried`, `guardrails`) | persistent | everything except uninstall (`enabled` is reset to off on a fresh start, see [The on/off switch](#the-onoff-switch)) |
| In memory (debugger attachments, console/error and network buffers, approval waiters, in-flight requests, held modifier keys) | SW lifetime | nothing |

## Persisted files (CLI side)

Only settings live in the config directory. Files `bvl` generates go to the data directory, logs to the state directory (`cli/src/main.rs`: `config_dir`, `data_dir`, `state_dir`):

| Directory | Source | Linux | macOS | Windows |
|---|---|---|---|---|
| `<config>` | `dirs::config_dir()` | `~/.config/browser-valet` | `~/Library/Application Support/browser-valet` | `%APPDATA%\browser-valet` |
| `<data>` | `dirs::data_local_dir()` | `~/.local/share/browser-valet` | `~/Library/Application Support/browser-valet` | `%LOCALAPPDATA%\browser-valet` |
| `<state>` | `dirs::state_dir()`, else `data_local_dir()` | `~/.local/state/browser-valet` | `~/Library/Application Support/browser-valet` | `%LOCALAPPDATA%\browser-valet` |

Linux honours `$XDG_CONFIG_HOME`, `$XDG_DATA_HOME` and `$XDG_STATE_HOME`. The data dir is Local, not Roaming, on Windows, because the browser loads the managed folder from this machine. Overrides: `BVL_CONFIG_DIR` replaces `<config>`; `BVL_DATA_DIR` replaces `<data>` and `<state>`. If only `BVL_CONFIG_DIR` is set, `<data>` and `<state>` use it too, so a test that sets only that never touches the user's real folders.

| File | Dir | Content | Notes |
|---|---|---|---|
| `config.json` | config | `{secret, port}` | mode 0600; a missing secret means "not paired" |
| `extension/` | data | the embedded extension, written by `setup` and the proxy | managed folder; stale files are removed, except `pairing.json` |
| `extension/pairing.json` | data | `{secret, port}` | mode 0600; written last, after the files are consistent |
| `skills/<name>/`, `skills/.version` | data | expanded skills | rewritten when `.version` differs |
| `proxy.log` | state | stderr of the detached proxy | for humans only |

## Version alignment and self-update

```mermaid
sequenceDiagram
  participant C as new bvl CLI
  participant P as proxy
  participant E as extension (old)
  C->>P: auth → welcome(version old)
  C->>P: shutdown; start own proxy; reconnect once
  E->>P: auth(info.managed, extVersion old)
  P->>P: rewrite managed folder + pairing.json
  P->>E: update(version)
  E->>E: wait for in-flight (≤120 s), save handoff, runtime.reload()
  E->>P: reconnect as new version, restore handoff (<60 s old)
```

- After a handoff restore, the extension ignores `canceled_by_user` detaches for 5 s, because a reload drops all debugger attachments. It re-attaches lazily.
- Pending approvals are dropped on handoff, because their CLI waiters are gone. Grants carry over.
- If an update fails to take effect, `updateTried` stops retries to the same version for 10 minutes.

Request lifecycle rules (in the proxy):

- Every `req` is owned by a drop guard in `request`. On any exit (final `res`, failed write to the CLI, CLI disconnect, cancelled task) it removes the pending entry, and if the entry was still pending it sends `cancel` to the extension. A request that was already answered or failed is never cancelled twice.
- `shutdown` fails every pending request with a `res` (exit 1, "proxy is shutting down") and sends `cancel` to the extension, then waits up to 1 s for those replies to be written before exiting.
- A CLI that sees a different proxy version asks `status` first. If `proxy.pending` is above 0 it does **not** restart the proxy: it exits with an error naming the conflict. Use one bvl version at a time; otherwise two versions would restart each other's proxy in a loop. A proxy without `pending` (older) counts as idle.

## Gotchas

- `bvl status` starts a proxy if none is running, so that it can report the extension. This is intended: any `bvl` command would start it anyway.
- On Windows the proxy is spawned with `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`. On Unix it gets its own process group. This path has no automated tests.
- `BVL_EXT_WAIT_MS` (how long a request waits for an extension, default 10 s) is a test hook that production code also reads.
- Writing the managed folder is synchronous inside the async proxy. That is fine at its size, but don't add heavy work there.
- `chrome.storage.session` has a 10 MB quota, and the whole `state`, including refs, is rewritten on every change (coalesced per microtask). Keep refs and the log bounded.

## Change risk

| Area | Risk | Required care |
|---|---|---|
| Managed folder path, persisted file keys | High | stay compatible or migrate; test with `cli/tests/relay.rs` update tests |
| Update/handoff flow | Medium | manual test of an old managed extension updating with an agent tab open |
| `State` shape | Medium | defaults in `initial()`; test handoff from the previous version |
| Idle timer, ext wait, retry intervals | Low | relay tests |
