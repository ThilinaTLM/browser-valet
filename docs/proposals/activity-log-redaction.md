# Activity-log redaction

**Status:** Draft · **Area:** security

## Problem

The popup's activity log should never show text the agent typed. Redaction is positional and limited to `fill`, `type` and `keyboard`. So `find … fill <text>`, `find … type <text>`, `dialog accept <text>` and `eval <js>` (truncated to 120 chars) are logged in plain text and kept in `chrome.storage.session`.

## Current state

[security.md](../architecture/security.md) (rule and debt marker). Code: `SECRET_ARGS` and `describe()` in `extension/src/background/dispatch.ts`.

## Options

1. Extend `SECRET_ARGS` with the missing commands. This is small, but every new command must remember it.
2. Add a `secretArgs` field (or a `redact(argv)` hook) to each `Command` and log only the redacted form. Redaction then lives next to the parser and works for nested `find … <action>`.
3. Log only the command name and target, never free-text arguments.

## Recommendation

Option 2. A default of "redact free text" for new commands keeps them safe.

## Open questions

- Should `eval` be logged at all, or only as `eval (N chars)`?
