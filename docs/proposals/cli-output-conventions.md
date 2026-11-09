# CLI output conventions: what to borrow from agent-browser

**Status:** Draft · **Area:** automation

## Problem

Running agent-browser 0.41.2 side by side with our code
([observed-output.md](agent-browser-parity/observed-output.md)) shows that the basics already match:
`✓ Done`, `✓ <title>\n  <url>`, `✗ <error>` on stderr, and `--json` `{success, data, error}`. A few
upstream conventions make the agent loop smoother, and our output differs from them in small ways.
A few of our own choices are better than upstream's and should stay.

## Borrow

1. **Waits print what they matched.** `wait --text "Welcome back"` prints `Welcome back`, and
   `wait --url "**/dashboard"` prints the final URL. The agent learns where it landed without a
   `get url`. bctl prints `✓ Done`. Change: `--url` prints the URL, `--text` prints the text, and
   element and `--fn` waits stay `✓ Done`. JSON adds `{ url }` / `{ text }`.
2. **Side information goes to stderr, results to stdout.** When an action opens a confirm or prompt
   dialog, upstream prints `✓ Done` on stdout and
   `⚠ A JavaScript confirm dialog is blocking the page: "…" — use \`dialog accept\` or \`dialog dismiss\``
   on stderr. bctl puts the notice into stdout (`raceDialog`). Move it to `stderr`, so stdout stays
   machine-clean. This needs a `Result.warning` that `execute` routes to stderr; the protocol
   already carries both streams. Use the same `⚠` channel for other non-fatal notes (a truncated
   full-page screenshot, a `tab` list hint).
3. **Machine error codes in `--json`.** Upstream adds `type` (`unknown_command`) and documents
   `code: "tab_gone"` with a recovery object. Add a stable `code` to our JSON errors so agents can
   branch without string matching:

   | code | when |
   |---|---|
   | `unknown_command`, `bad_args` | parsing / usage |
   | `unknown_ref`, `stale_ref`, `not_found`, `not_visible`, `disabled`, `covered` | targeting |
   | `timeout` | waits and `--timeout` |
   | `dialog_open` | a confirm/prompt dialog blocks the tab |
   | `no_tab`, `tab_gone`, `not_shared`, `denied`, `revoked` | tabs and consent (bctl-specific) |
   | `not_connected` | extension or proxy (produced by the proxy/CLI) |

   Implementation: `UserError` gains an optional `code`. JSON becomes
   `{ success: false, data: null, error, code }`. Text output is unchanged. For unknown commands,
   mirror upstream's exact shape (`type: "unknown_command"`) **and** `code`.
4. **Missing arguments print the usage line.** Upstream prints `Missing arguments for: click` and
   `Usage: agent-browser click <selector> …`. Ours prints `Missing target`. Append
   `Usage: bctl <usage>` from the `Command` table to `bad_args` errors.
5. **Richer per-command help.** Upstream's `<cmd> --help` has a behaviour paragraph (for example "click
   fails, instead of reporting success, when the element is hidden, disabled, or outside the
   viewport") and an `Examples:` block. Add optional `details` and `examples` to `Command`, and
   render them in `commandHelp`. Top-level `bctl help` gets upstream's "Start here (for AI agents):
   `bctl skills get core`" block.
6. **JSON field names line up with upstream**, where the data is the same:

   | Command | bctl `data` today | upstream `data` |
   |---|---|---|
   | `console` | `{ messages: string[] }` | `{ messages: [{ type, text, args }] }` |
   | `errors` | `{ errors: string[] }` | `{ errors: [{ text, line, column, url }] }` |
   | `dialog status` | `{ open, type, message, defaultPrompt }` | `{ hasDialog, type, message, defaultPrompt }` |
   | `tab` (list) | `[ {tabId, label, title, …} ]` | `{ tabs: [ {tabId, label, title, url, active, …} ] }` |
   | `click` | `null` | `{ clicked: "@e11" }` |
   | `eval`, `is`, `snapshot` | no `origin` on some | `origin` (current URL) on page commands |

   Keep bctl-only fields (`shared`, `pending`) alongside upstream's.

## Keep ours (better than upstream)

- Error hints that say what to do next (`Unknown ref: e9. Run \`bctl snapshot\` …`,
  `Element is covered by <div#…>`). Upstream's `Unknown ref: e99` has no hint. Its generic "Verify the
  selector…" suffix is fine to add to `not_found`.
- `get attr` on a missing attribute prints `null`. Upstream prints `✓ Done`, which reads like an
  action.
- `errors` text output: upstream prints empty `✗` lines (a bug). Ours prints the messages.
- No `lifecycle` object in every JSON response.
- `get styles` curated by default (see [small-parity-commands.md](small-parity-commands.md)).

## Impact

- `dispatch.ts` (stderr warnings, error codes, help), `command.ts` (`UserError.code`, usage on missing
  arguments), the command files (wait output, JSON fields), `cli/skills/core/` (wait output, JSON
  error codes).
- The protocol is unchanged (`res` already has stdout and stderr). Proxy-generated errors
  ("extension not connected") get `code` only if the CLI prints JSON for them. Check `main.rs`.
- Risk: Low–Medium. Output text changes, so update the skills in the same change.

## Open questions

- Should the `code` key be named `type`, like upstream's unknown-command error? (Recommended: emit
  both for unknown commands only, and use `code` everywhere else, since upstream is itself
  inconsistent.)
