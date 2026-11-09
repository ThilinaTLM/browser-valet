# `batch`: several commands in one call

**Status:** Draft · **Area:** automation

## Problem

Each `bctl` call costs one process start plus one WebSocket round trip, and an agent turn per
command. Short, predictable sequences (fill, fill, click, wait) would be faster and use fewer tokens
as one call. agent-browser has `batch "cmd1" "cmd2" …` with `--bail` and `--json`.

## Design

```bash
bctl batch "fill @e1 user@example.com" "fill @e2 hunter2" "click @e3" "wait --url **/home"
bctl batch --bail …          # stop at the first failure
bctl batch --stdin <<'EOF'   # one command per line
open https://example.com
snapshot -i
EOF
```

- Runs entirely in the extension (principle 3). The CLI already forwards argv and `--stdin`, so it
  needs no change.
- Each item is split into argv with a small shell-like tokenizer (single and double quotes,
  backslash escapes, no expansion). Global flags (`--session`, `--timeout`, `--json`) apply to the
  whole batch. Per-item `--session` is rejected.
- Items run one after another through the same `execute` path (parse → `Ctx` → `raceDialog`), so
  consent, dialogs and errors behave exactly as in single calls. A confirm/prompt dialog ends the
  batch, as it ends a single command.
- `files` from all items are merged into the one response.
- Output, matching upstream 0.41.2 ([observed-output.md](agent-browser-parity/observed-output.md)):
  - Text: each item's stdout one after another, separated by a blank line. Errors go to stderr as
    `✗ …`. Exit 1 if any item failed (with or without `--bail`).
  - `--json`: a **top-level array**
    `[{ command: [argv…], success, result, error }]`. It is not wrapped in `{success, data}`, and
    each item's `result` is the `data` it would return on its own. `--omit-command` replaces
    `command` with `index`.
  - Possible improvement over upstream (a small deviation): in text mode, prefix each item with
    `[n] <command>` only when the batch has more than one failure, to keep it easy to scan.
    Default: no prefix, match upstream.
- Not allowed inside a batch: `batch` itself, and `eval --stdin` (stdin belongs to the batch).
  `eval -b` still works.
- `--timeout` is per item, not for the whole batch.

## Security

- **Activity log:** one log entry per item, built by the same `describe` function, so redaction
  applies per item. Do **not** log the raw batch line. This must account for
  [activity-log-redaction.md](activity-log-redaction.md).
- No new capability. Every item is a command the agent could already run.

## Open questions

- Cancellation: when the CLI disconnects mid-batch, should the current item's abort also skip the
  rest? (Yes: the batch shares one `AbortSignal`.)
