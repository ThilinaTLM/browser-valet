# Browser Bridge

Let coding agents use your **real** Chrome — your logins, cookies and open tabs — through a small
CLI, `bctl`, whose commands mirror [agent-browser](https://github.com/vercel-labs/agent-browser).
You stay in control: agents only touch tabs they opened or tabs you explicitly approve.

```mermaid
flowchart LR
  CLI["bctl (Rust)<br/>thin client: argv in, output out"] -->|WebSocket, mutual HMAC| P["bctl proxy<br/>stateless relay, exits when idle"]
  EXT["Extension (TypeScript)<br/>source of truth: sessions, tabs, refs,<br/>parsing, help, consent, activity"] -->|WebSocket, mutual HMAC| P
  EXT -->|chrome.debugger| T[your tabs]
```

- **Simple by design.** The CLI sends raw arguments; the extension parses, runs and formats
  everything (so new commands are extension-only). The proxy keeps no state and exits after 10
  idle minutes; the next `bctl` command starts it again.
- **Cross-platform.** One Rust binary for Linux, macOS and Windows; works with Chrome, Edge,
  Brave and other Chromium browsers (≥127).
- **Consent first.** Agent-opened tabs are the agent's. Any other tab needs your approval in a
  popup; you can revoke control at any time (popup, or close Chrome's "debugging" bar).

## Install

**CLI**

```sh
cargo install --path cli        # puts `bctl` in ~/.cargo/bin (make sure it's on PATH)
```

**Extension**

```sh
cd extension && pnpm install && pnpm build
```

Open `chrome://extensions`, enable **Developer mode**, **Load unpacked** → `extension/dist`.

**Pair** — click the Browser Bridge toolbar icon, copy the pairing command it shows and run it:

```sh
bctl pair <code>
bctl status          # extension: Google Chrome … (extension v0.2.0)
```

## Usage

```sh
bctl open https://example.com        # the agent's own tab, opened in the background
bctl snapshot -i                     # interactive elements with refs
# - link "Learn more" [ref=e1]
bctl click @e1
bctl get url
bctl tab                             # all tabs; [not shared] = needs your approval
bctl tab t4                          # asks you in the browser, waits for the answer
bctl close                           # close the session's tabs, release yours
```

Run `bctl help` for every command. `SKILL.md` is a ready-made skill for coding agents.

| Area | Commands |
|---|---|
| Navigation | `open` (`goto`, `navigate`), `back`, `forward`, `reload`, `close` |
| Tabs | `tab`, `tab new [--label L] [url]`, `tab <tN\|label>`, `tab close` |
| Reading | `snapshot [-i -c -d N -s sel -u]`, `get text\|html\|value\|attr\|title\|url\|count\|box`, `is visible\|enabled\|checked`, `screenshot [--full]`, `eval` (`-b`, `--stdin`) |
| Interaction | `click [--new-tab]`, `dblclick`, `hover`, `focus`, `fill`, `type`, `press`, `keydown`, `keyup`, `keyboard`, `check`, `uncheck`, `select`, `scroll`, `scrollintoview`, `drag`, `upload`, `find …` |
| Waiting | `wait <t\|ms>`, `--text`, `--url <glob>`, `--load`, `--fn`, `--state`; `dialog status\|accept\|dismiss` |
| Debugging | `console`, `errors` |

Global flags: `--json` (`{success, data, error}`), `--session <name>` (or `BCTL_SESSION`),
`--timeout <ms>`. CLI-local commands: `pair`, `unpair`, `status`, `stop`, `proxy`, `version`.

Deliberately left out: cookies/storage/state, network interception, emulation, video/trace/pdf —
they would modify your real profile or aren't needed for driving pages.

## The extension popup

- Connection status, on/off switch, and the pairing command.
- **Permission requests** from agents (Allow / Deny) — the popup opens by itself when one arrives.
- **This tab**: share the tab you're looking at with agents, or stop sharing it.
- **Agent tabs**: everything agents control right now, with Stop / Stop all.
- **Recent activity**: the last commands, with typed text redacted.

Controlled tabs show an **AI** badge on the toolbar icon.

## How it works

- `PROTOCOL.md` describes the wire protocol. Both sides prove knowledge of the pairing secret
  with an HMAC challenge–response, so the secret never crosses the wire and a process squatting
  on the port while the proxy is down can't impersonate it. Web pages are rejected by `Origin`.
- Agent tabs open in the background so you can keep working. Chrome doesn't render hidden tabs
  and drops input aimed at them; before each mouse/keyboard action the extension forces one frame
  (a 1×1 capture), which makes trusted input work without stealing focus.
- State (sessions, tab ids, refs, approvals, activity) lives in the extension
  (`chrome.storage.session`), so it survives service-worker restarts and proxy restarts.

## Configuration

| | |
|---|---|
| `BCTL_PORT` | Proxy port (default `47823`; also `bctl pair --port`, and the popup's Settings) |
| `BCTL_SESSION` | Default session name |
| `BCTL_IDLE_TIMEOUT` | Proxy idle shutdown in seconds (default 600, `0` = never) |
| `BCTL_CONFIG_DIR` | Override the config directory (tests) |

Config lives in `~/.config/browser-bridge` (Linux), `~/Library/Application Support/browser-bridge`
(macOS) or `%APPDATA%\browser-bridge` (Windows); the proxy logs to `proxy.log` there.

## Development

```sh
cd cli && cargo test                         # relay + client integration tests
cd extension && pnpm check && pnpm build     # typecheck, eslint, prettier, bundle
pnpm watch                                   # rebuild on change, then reload the extension
```

## Limitations

- Cross-origin (out-of-process) iframes aren't included in snapshots; same-origin ones are.
- Chrome pages (`chrome://…`, the Web Store) can't be controlled.
- One browser connects at a time (the most recent one wins).
- Firefox isn't supported (no `chrome.debugger`).
