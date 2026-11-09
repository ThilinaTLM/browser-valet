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
- **Pointer commands:** `mouse move|down|up|wheel` send `Input.dispatchMouseEvent` after `prime`. The pointer position and held buttons are kept per tab in memory (`commands/extra.ts`), so moves while a button is held report `buttons` and `down`/`up` act at the last position (0,0 before any move). `move --duration ms --steps n` interpolates; steps default to one per 16 ms of duration. Chrome never processes wheel input for hidden tabs, so on a hidden tab `mouse wheel` scrolls the element under the pointer by script (no `wheel` event reaches the page). Hidden tabs also coalesce moves to about one per frame.
- **Highlight:** `highlight <t>` draws `Overlay.highlightNode` (enables `DOM` and `Overlay`) and hides it after 3 s with `Overlay.hideHighlight`, or when the tab is highlighted again. A service-worker restart in between leaves it until the page reloads.
- **Selectors:** targets are `@ref`, CSS or XPath. `dom.ts` treats a target starting with `/` or `(` as XPath (first match via `document.evaluate`); `get count` counts all matches. `wait`, `click` and the rest go through `resolve`, so they accept XPath too.
- **`get styles`:** prints `name: value` lines for a curated set (font, colour, background, display, visibility, opacity, position, size, margin, padding, border, z-index, cursor, pointer-events, overflow); `get styles <t> <prop…>` only those; `--all` every computed property, sorted (upstream prints all by default, ~450 lines).
- **`pushstate <url>`:** same-origin only. Uses `window.next.router.push` when present, otherwise `history.pushState` plus a `popstate` event. Prints the resolved URL.
- **`session list|info`:** read-only views of `state.sessions`/`state.tabs`: current tab (only if shared with the agent), owned tabs and last activity from the activity log. `info` shows tab, label, title, URL and `Frame: main`. Unlike upstream, `--json` `sessions` are objects, not names.
- **Navigation:** `Page.navigate` can swap renderer processes and detach the debugger. In that case navigation retries once, then falls back to the tabs API. Discarded tabs are reloaded when selected.
- **Snapshot and refs:** `Accessibility.getFullAXTree` is rendered as an agent-browser-style tree. Refs `@eN` go to interactive roles and to named headings, images, cells and dialogs. Refs are **stable and monotonic** (as in agent-browser): the tab keeps a `backendNodeId → ref` map (`state.refs[tabId]`, pure logic in `ref-table.ts`), so `snapshot`, `snapshot -i` and later snapshots give the same element the same ref, and new nodes take `e<nextRef>` from a counter kept per session (`state.sessions[s].nextRef`, raised above any ref already in the tab). A cross-document navigation of the main frame (link, reload, `open`) clears the tab's map but **keeps the counter**, so an old `@e7` fails with `Unknown ref: e7` instead of hitting a different element. The document is identified by the main frame's `loaderId` (`state.refDocs`, checked on `Page.frameNavigated` and again by `syncDocument` before every snapshot and ref resolution, which covers missed events and worker restarts); same-document navigation (`pushState`, hash) keeps refs. A full, unscoped snapshot drops refs whose node left the accessibility tree (`removedRefs`); scoped or depth-limited snapshots drop nothing. `resolveRef` falls back to a unique role+name match when a backend node id has gone stale, but only for refs of the current document. Same-origin iframes are inlined. Cross-origin (OOPIF) iframes are not.
- **`read [url]`:** page text as markdown. With a URL it first runs `open <url>` (so it never navigates a shared tab), then evaluates `dist/read-extractor.js` in the page (loaded once from the extension package, so it stays out of the service-worker bundle; ~46 KB minified with Mozilla Readability and Turndown). The extractor takes the largest `main`/`[role=main]`/`article`; without one, Readability picks the content, else the body. `script`, `style`, `nav`, `aside` and hidden elements are dropped. Links keep their text only, tables become GFM tables. `--outline`, `--filter` and `--max-output` run in the service worker on the markdown (`read-format.ts`) and mirror agent-browser 0.41.2: `# Outline` / `Source: <url>` / nested `- heading` list; `--filter` returns each section (heading + subsections) whose heading or own text contains the text, or `No matching page sections`; truncation appends `[truncated: showing N of M chars. Use --max-output to adjust]`. No HTTP fetch mode (`--llms`, `--require-md`) by design: the CLI stays thin and a service-worker fetch would send cookies without a visible tab.
- **Input:** `prime` checks `document.visibilityState`. If the page is hidden, a 1×1 `Page.captureScreenshot` forces a frame, and then `Input.dispatch*` delivers trusted events without focusing the tab. Held modifier keys are module-global.
- **Full-page screenshots:** the page size comes from `Page.getLayoutMetrics`. Captures in 8000 px slices are stitched in an `OffscreenCanvas`, capped at 32000 device px (`truncated` flag).

- **Attach conflicts:** `cdp.attach` treats "already attached" as possibly ours (a previous worker's attachment) and probes with a cheap `Runtime.evaluate`. If the probe fails, another debugger owns the tab and the command fails with "Another debugger is attached to this tab (DevTools or another extension). Close DevTools on this tab…". Chrome's wording is identical for both cases, so only the probe tells them apart. Observed in Chrome for Testing 152 (`chrome.debugger` from the extension worker): `attach` on a tab the extension already holds → `Another debugger is already attached to the tab with id: N.`; `sendCommand` or `detach` on a tab the extension does not hold → `Debugger is not attached to the tab with id: N.` (a probe on a foreign attachment fails this way). A second CDP client (such as DevTools or puppeteer) does not cause either error: Chrome allows several clients on one tab. The foreign-debugger case therefore needs another extension holding `chrome.debugger`, and is covered by a unit test, not an E2E test.

## Gotchas

- Attaching shows Chrome's debugging bar. Closing it revokes the tab (see [security.md](security.md)).
- Hidden tabs throttle timers and stop `requestAnimationFrame`. Waits based on page JS may be slow in agent tabs.
- `raceDialog` returns while the command keeps running in the background. Its later side effects (grants, log entries) still happen.
- Pointer state (`mouse`) is per tab and, like held modifier keys, lost on a service-worker restart.
- Held modifier keys (`keydown`) are shared across tabs and sessions and are lost on a service-worker restart.
- `tab` (list) assigns `tN` ids to every tab it lists, shared or not. This is intended: the agent needs an id to ask for an unshared tab.
- The supported floor is Chrome 127 (`minimum_chrome_version`). `build.mjs` targets the same version; change both together.

## Change risk

| Area | Risk | Required care |
|---|---|---|
| Snapshot format, ref numbering, output text | Medium | agents and skills depend on it; update `cli/skills/` |
| Input/prime path | Medium | manual test on a background agent tab and on a shared foreground tab |
| Adding a command | Low | follow the `Command` table; consider redaction ([security.md](security.md)) |
