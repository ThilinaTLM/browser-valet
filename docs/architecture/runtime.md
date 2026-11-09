# Runtime, state and updates

Process lifetimes, where state lives, persisted files, and the self-update flow. Code:
`cli/src/{main,proxy,embed}.rs` and `extension/src/background/{state,connection,index}.ts`.
Message formats: [protocol.md](protocol.md).

## Rules

- **MUST** keep the proxy free of durable state. Its memory holds only the extension connection, pending requests and the idle clock. *Why:* the CLI starts it on demand and it exits when idle. Anything stored there would be lost silently.
- **MUST** keep the managed folder path (`<config>/browser-bridge/extension`) and the `config.json` / `pairing.json` keys (`secret`, `port`) stable. *Why:* the user picked that folder once in Load unpacked. Moving it or renaming keys strands every install.
- **MUST** auto-update only managed extensions, and only when the binary embeds an extension of a different version. *Why:* a dev build loaded from `extension/dist` must never be overwritten. `bctl status` only reports its mismatch.
- **Default:** new fields in the extension's `State` must have a default in `initial()`. *Why:* stored and handed-off state is spread over `initial()`, so state from an older version lacks the field.
- **Default:** one extension connection at a time; the newest authenticated one replaces the old one.

## Lifetimes

| Process / store | Lifetime | Survives |
|---|---|---|
| CLI | one command | — |
| Proxy | started detached by the CLI on demand. Exits after `BCTL_IDLE_TIMEOUT` (default 600 s, `0` = never) with no requests in flight. Pings don't count as activity. | nothing; it holds no durable state |
| Extension service worker | killed by Chrome when idle. The 20 s keep-alive ping and a 30 s alarm limit this. | `chrome.storage.session` |
| `chrome.storage.session` `state` (tabs, grants, sessions, refs, approvals, log) | until the extension is reloaded or disabled, or the browser restarts | SW and proxy restarts; self-update (via handoff) |
| `chrome.storage.local` (`secret`, `port`, `enabled`, `paired`, `handoff`, `updateTried`) | persistent | everything except uninstall |
| In memory (debugger attachments, console/error and network buffers, approval waiters, in-flight requests, held modifier keys) | SW lifetime | nothing |

## Persisted files (CLI side)

All under `<config>/browser-bridge` (`dirs::config_dir()`, overridable with `BCTL_CONFIG_DIR`):

| File | Content | Notes |
|---|---|---|
| `config.json` | `{secret, port}` | mode 0600; a missing secret means "not paired" |
| `extension/` | the embedded extension, written by `setup` and the proxy | managed folder; stale files are removed, except `pairing.json` |
| `extension/pairing.json` | `{secret, port}` | mode 0600; written last, after the files are consistent |
| `skills/<name>/`, `skills/.version` | expanded skills | rewritten when `.version` differs |
| `proxy.log` | stderr of the detached proxy | for humans only |

## Version alignment and self-update

```mermaid
sequenceDiagram
  participant C as new bctl CLI
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
- A CLI that sees a different proxy version asks `status` first. If `proxy.pending` is above 0 it does **not** restart the proxy: it exits with an error naming the conflict. Use one bctl version at a time; otherwise two versions would restart each other's proxy in a loop. A proxy without `pending` (older) counts as idle.

## Gotchas

- `bctl status` starts a proxy if none is running, so that it can report the extension. This is intended: any `bctl` command would start it anyway.
- On Windows the proxy is spawned with `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`. On Unix it gets its own process group. This path has no automated tests.
- `BCTL_EXT_WAIT_MS` (how long a request waits for an extension, default 10 s) is a test hook that production code also reads.
- Writing the managed folder is synchronous inside the async proxy. That is fine at its size, but don't add heavy work there.
- `chrome.storage.session` has a 10 MB quota, and the whole `state`, including refs, is rewritten on every change (coalesced per microtask). Keep refs and the log bounded.

## Change risk

| Area | Risk | Required care |
|---|---|---|
| Managed folder path, persisted file keys | High | stay compatible or migrate; test with `cli/tests/relay.rs` update tests |
| Update/handoff flow | Medium | manual test of an old managed extension updating with an agent tab open |
| `State` shape | Medium | defaults in `initial()`; test handoff from the previous version |
| Idle timer, ext wait, retry intervals | Low | relay tests |
