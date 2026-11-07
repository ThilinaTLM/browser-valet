---
name: bctl
description: Control the user's real Chrome browser (with their logins) via the `bctl` CLI. Use when a task needs an actual logged-in browser session rather than a fresh test browser.
---

# bctl — drive the user's real browser

This acts in the user's real, logged-in browser. Be careful: don't submit forms, purchase, post or
delete anything without the user's confirmation. Prefer opening your own tab (`bctl open`) over
hijacking a tab the user is using.

Workflow:
1. `bctl status` — must say `extension: connected`.
2. `bctl open <url>` (or `bctl tabs` + `bctl use <id>`).
3. `bctl snapshot -i` → read refs like `[ref=e3]`.
4. Act: `bctl click @e3`, `bctl fill @e1 "text"`, `bctl press Enter`, `bctl select @e4 "Option"`.
5. Re-snapshot after navigation / DOM changes (refs go stale).
6. Verify: `bctl get text @e5`, `bctl wait --text "Done"`, `bctl screenshot out.png`.
7. `bctl detach` when finished (removes the debugging bar).

Other: `goto`, `back`, `reload`, `hover`, `type --into <t> "text"`, `scroll down 800`,
`scrollintoview <t>`, `get title|url|html|value`, `eval "<js>"`, `wait <ms|selector>`,
`--tab <id>` to target a tab, `--json` for machine-readable output. Targets may be refs (`@e3`) or
CSS selectors.
