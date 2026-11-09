# Extension tests

**Status:** Draft · **Area:** development

## Problem

The extension owns all state, consent and parsing, yet it has no automated tests. Regressions in consent, handoff or argument parsing are found only by hand.

## Current state

[development.md](../architecture/development.md) (debt marker). CI runs only `pnpm check` and `pnpm build` for the extension.

## Options

1. Unit tests (for example with Vitest) for pure modules: `parseArgs`, help generation, `describe()` redaction, `restoreHandoff` merge, label rules. Mock `chrome.*` for state and consent.
2. End-to-end tests: Puppeteer/Playwright with Chromium loading `extension/dist` plus a real `bctl proxy`, covering open, snapshot, click on a background tab, approve and revoke.
3. Both: option 1 first, then a small option 2 smoke suite in CI on Linux.

## Recommendation

Option 3.

## Open questions

- Can CI approve consent prompts without a test-only bypass, and if not, what is the minimal one?
