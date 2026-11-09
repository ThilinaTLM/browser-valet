# Browser automation

How commands are parsed and run, and how CDP is used to read and drive pages. Code:
`extension/src/background/` (`dispatch.ts`, `command.ts`, `cdp.ts`, `input.ts`, `snapshot.ts`,
`dom.ts`, `commands/*.ts`). The agent-facing command reference is in `cli/skills/core/`.

## Rules

- **Default:** commands mirror [agent-browser](https://github.com/vercel-labs/agent-browser) names, flags and snapshot format (principle 5 in [README.md](README.md)). When adding a command, copy agent-browser's syntax if it has one. *Why:* agents already know that vocabulary, and the skill relies on it.
- **Default:** a new command is a `Command` entry in `commands/*.ts`, registered in `COMMANDS` (`dispatch.ts`). Help and `--json` output come from that table. The CLI needs no change.
- **MUST** prime before any trusted input on a possibly hidden tab (use the helpers in `input.ts`). *Why:* agent tabs open in the background. Chrome doesn't render hidden tabs and drops input aimed at them.
- **MUST** get the tab via `ctx.tab()` (see [security.md](security.md)).
- **Default:** CDP calls that may hang on hidden or dialog-blocked pages are raced against a short timeout (prime 500 ms, input events 300 ms) or against `raceDialog`.
- **Default:** behaviour or output changes update `cli/skills/core/` in the same change.

## Design

- **Dispatch:** `execute` parses argv (`parseArgs`: `--k=v`, combined short booleans, `--`, negative numbers) and finds the command. It runs the command under an `AbortController` and formats `{exitCode, stdout, stderr, files}` (text or `--json` `{success, data, error}`). `cancel` aborts waits, consent and dialogs, but not a CDP call already in flight.
- **CDP:** `chrome.debugger` protocol 1.3 is attached lazily per tab, with `Page` and `Runtime` enabled. Console messages and exceptions are buffered per tab in memory. `alert` and `beforeunload` dialogs are auto-accepted. `confirm` and `prompt` end the command early so that the agent can use `dialog accept|dismiss`.
- **Navigation:** `Page.navigate` can swap renderer processes and detach the debugger. In that case navigation retries once, then falls back to the tabs API. Discarded tabs are reloaded when selected.
- **Snapshot and refs:** `Accessibility.getFullAXTree` is rendered as an agent-browser-style tree. Refs `@eN` go to interactive roles and to named headings, images, cells and dialogs. Each snapshot replaces the tab's ref map. `resolveRef` falls back to a unique role+name match when a backend node id has gone stale. Same-origin iframes are inlined. Cross-origin (OOPIF) iframes are not.
- **Input:** `prime` checks `document.visibilityState`. If the page is hidden, a 1×1 `Page.captureScreenshot` forces a frame, and then `Input.dispatch*` delivers trusted events without focusing the tab. Held modifier keys are module-global.
- **Full-page screenshots:** the page size comes from `Page.getLayoutMetrics`. Captures in 8000 px slices are stitched in an `OffscreenCanvas`, capped at 32000 device px (`truncated` flag).

- **Attach conflicts:** `cdp.attach` treats "already attached" as possibly ours (a previous worker's attachment) and probes with a cheap `Runtime.evaluate`. If the probe fails, another debugger owns the tab and the command fails with "Another debugger is attached to this tab (DevTools or another extension). Close DevTools on this tab…". Chrome's wording is identical for both cases, so only the probe tells them apart. Observed in Chrome for Testing 152 (`chrome.debugger` from the extension worker): `attach` on a tab the extension already holds → `Another debugger is already attached to the tab with id: N.`; `sendCommand` or `detach` on a tab the extension does not hold → `Debugger is not attached to the tab with id: N.` (a probe on a foreign attachment fails this way). A second CDP client (such as DevTools or puppeteer) does not cause either error: Chrome allows several clients on one tab. The foreign-debugger case therefore needs another extension holding `chrome.debugger`, and is covered by a unit test, not an E2E test.

## Gotchas

- Attaching shows Chrome's debugging bar. Closing it revokes the tab (see [security.md](security.md)).
- Hidden tabs throttle timers and stop `requestAnimationFrame`. Waits based on page JS may be slow in agent tabs.
- `raceDialog` returns while the command keeps running in the background. Its later side effects (grants, log entries) still happen.
- Held modifier keys (`keydown`) are shared across tabs and sessions and are lost on a service-worker restart.
- `tab` (list) assigns `tN` ids to every tab it lists, shared or not. This is intended: the agent needs an id to ask for an unshared tab.
- The supported floor is Chrome 127 (`minimum_chrome_version`). `build.mjs` targets the same version; change both together.

## Change risk

| Area | Risk | Required care |
|---|---|---|
| Snapshot format, ref numbering, output text | Medium | agents and skills depend on it; update `cli/skills/` |
| Input/prime path | Medium | manual test on a background agent tab and on a shared foreground tab |
| Adding a command | Low | follow the `Command` table; consider redaction ([security.md](security.md)) |
