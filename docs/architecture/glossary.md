# Glossary

Project terms as used in code and docs.

| Term | Meaning here | Not to be confused with |
|---|---|---|
| activity log | The last 50 commands the extension ran (`state.log`), shown in the popup, with secret arguments redacted. See [security.md](security.md). | `proxy.log` (proxy stderr on disk) |
| agent tab | A tab with `control: 'agent'`. The agent opened it, or a controlled tab opened it. See [security.md](security.md). | shared tab |
| approval | A pending consent request for one tab (`state.approvals`), answered with Allow/Deny in the popup. See [security.md](security.md). | grant (the result of an approval) |
| `bvl` | The single Rust binary. It is the CLI, and with `bvl proxy` it is also the proxy. | the extension |
| CLI-local command | A command the CLI handles itself (`setup`, `skills`, `pair`, `status`, `doctor`…). Every other command is forwarded as a `req`. See [protocol.md](protocol.md). | command (runs in the extension) |
| control / grant | Per-tab permission (`TabMeta.control`: `'agent'` or `'user'`) plus the `owner` session. Removed by revoke. | Chrome extension permissions |
| ext | The extension's role on the wire (`role: "ext"`). See [protocol.md](protocol.md). | — |
| handoff | Extension state copied to `chrome.storage.local` before a self-update reload, then restored if it is under 60 s old. See [runtime.md](runtime.md). | session storage |
| managed | The extension runs from the folder that `bvl setup` wrote, with `pairing.json` present. Only managed extensions are auto-updated. See [runtime.md](runtime.md). | a dev build loaded from `extension/dist` |
| `pairing.json` | `{secret, port}` in the managed folder. It overrides the secret and port stored in the extension. | `config.json` (the CLI's copy of the secret) |
| prime | Forcing one frame in a hidden tab (a 1×1 capture) so trusted input is delivered. See [automation.md](automation.md). | — |
| proxy | `bvl proxy`: a stateless relay on `127.0.0.1` that exits when idle. | an HTTP proxy |
| ref (`@eN`) | Element handle from the last `snapshot` of a tab. Numbering restarts on every snapshot. See [automation.md](automation.md). | tab id (`tN`) |
| revoke | Removing control from a tab (popup Stop, closing the debug bar, `close`), which also detaches the debugger. | closing the tab |
| session | A named agent context (`--session`, `BVL_SESSION`, default `default`) with a current tab. It lives in the extension. | browser session, `chrome.storage.session` |
| shared tab | A tab the user approved (`control: 'user'`). `open <url>` never navigates it. | agent tab |
| tab id (`tN`) | Stable per-extension-lifetime tab name, assigned on first sight. It differs from Chrome's numeric tab id. | label (optional user-chosen name) |
| `updateTried` | Loop guard: the extension ignores a repeated update to the same version for 10 minutes. | — |
