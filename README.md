# browser-bridge

Control your **real** Chrome (logged-in sessions, cookies, extensions) from the shell.
Built for coding agents — a small, agent-browser-style CLI (`bctl`) plus a companion MV3 extension.

```
bctl (CLI) ──HTTP+token──▶ daemon (127.0.0.1:47823) ◀──WebSocket+token── extension ──chrome.debugger (CDP)──▶ tabs
```

- The extension dials **out** to the daemon (MV3 extensions can't listen on ports).
- The daemon is a thin relay; it auto-starts on the first `bctl` command.
- Tabs are driven with the `chrome.debugger` API, so input events are real/trusted. Chrome shows a
  "Browser Bridge started debugging this browser" bar while attached — `bctl detach` removes it.

## Install

```sh
cargo install --path .          # installs `bctl` into ~/.cargo/bin
bctl token                      # prints the pairing token (stored in ~/.config/browser-bridge/token)
```

1. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked** → select `extension/`.
2. Click the Browser Bridge toolbar icon, paste the token, **Save & connect**.
3. `bctl status` → `extension: connected`. The badge shows **ON**.

Works in Chrome/Chromium/Brave/Edge (≥120). Port can be changed with `BCTL_PORT` (and in the popup).

## Usage

```sh
bctl open https://example.com      # new tab, becomes the "current" tab
bctl snapshot -i                   # interactive elements with refs
#  - textbox "Email" [ref=e1]
#  - button "Sign in" [ref=e2]
bctl fill @e1 me@example.com
bctl click @e2
bctl wait --text "Welcome"
bctl screenshot shot.png --full
```

| Command | Notes |
|---|---|
| `tabs`, `use <id\|active>` | list tabs / pick the tab commands act on (`--tab <id>` overrides per call) |
| `open <url> [--bg]`, `goto <url>`, `back`, `forward`, `reload`, `close [id]` | navigation waits for load |
| `snapshot [-i] [-d N]` | accessibility tree; `-i` = flat list of interactive elements |
| `click <t> [--double] [--right]`, `hover <t>` | `<t>` = ref (`@e3`) or CSS selector |
| `fill <t> <text>` | select-all + insert (clears first) |
| `type <text> [--into <t>]`, `press <key>` | key events; `press Enter`, `press Control+a`, `press Shift+Tab` |
| `select <t> <value\|label>` | `<select>` elements |
| `scroll up\|down\|left\|right [px]`, `scrollintoview <t>` | |
| `get text\|html\|value\|title\|url [t]` | |
| `eval <js>` | runs in page, awaits promises, returns JSON value |
| `screenshot [path] [--full]` | PNG |
| `wait <ms>` / `wait <t>` / `wait --text s` / `wait --url s` / `wait --load` | uses `--timeout` (s) |
| `detach`, `status`, `stop`, `token`, `daemon` | |

Global flags: `--tab <id>`, `--json`, `--timeout <secs>` (default 30).

Refs are invalidated when the page changes — take a new snapshot after navigation or big DOM updates.

## Security

Anything holding the token can drive your logged-in browser. The daemon binds to 127.0.0.1 only,
requires the token on both sides, and only accepts WebSocket connections from `chrome-extension://`
origins. Use the **Enabled** toggle in the popup to switch control off.

## Limitations (MVP)

- Snapshots cover the main frame only (iframe contents aren't included).
- Screenshots of background tabs may be slow/blank — Chrome throttles hidden tabs.
- One connected browser at a time (the most recent connection wins).
- `chrome://` pages and the Web Store can't be controlled (Chrome restriction).
