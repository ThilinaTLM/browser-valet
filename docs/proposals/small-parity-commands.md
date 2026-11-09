# Small parity commands: `mouse`, `get styles`, `highlight`, `pushstate`, `session`, XPath, `wait --download`

**Status:** Draft · **Area:** automation

## Problem

Several small agent-browser commands are missing. Each is a `Command` entry in `commands/*.ts`
with no protocol, CLI or consent change. They are grouped here so they can ship together.

## Commands

### `mouse move|down|up|wheel`

```bash
bctl mouse move 100 200 [--duration ms] [--steps n]
bctl mouse down [left|right|middle]   bctl mouse up [button]
bctl mouse wheel <dy> [dx]
```

- `Input.dispatchMouseEvent` (`mouseMoved`, `mousePressed`, `mouseReleased`, `mouseWheel`) after
  `prime` (as for every input on a possibly hidden tab, see automation.md).
- Track the pointer position and held buttons per tab in memory, as with held modifier keys. They
  are lost on a service-worker restart; document that in Gotchas.
- `--duration/--steps` interpolate moves. Skip upstream's `--human` / `--seed` for now.
- Use cases: canvas apps, maps, sliders, custom drag handles.

### `get styles <t>`

Upstream 0.41.2 prints **every** computed property (~450 `name: value` lines,
[observed-output.md](agent-browser-parity/observed-output.md)). That is a token sink. Deviate on
purpose:

- Default: a curated set in the same `name: value` format (font family/size/weight, colour,
  background, display, visibility, opacity, position, width/height, margin, padding, border,
  z-index, cursor, pointer-events, overflow).
- `get styles <t> <prop…>`: only the named properties. `--all`: everything (upstream behaviour).
- Read-only.

### `highlight <t>`

`Overlay.highlightNode` (needs `DOM.enable` + `Overlay.enable`) with a visible outline, cleared on
the next command or after a few seconds (`Overlay.hideHighlight`). This matters more in bctl than
upstream: the user is watching their real browser, and seeing what the agent is about to touch
builds trust.

Possible follow-up (not in scope): a popup setting "Show agent actions", which flashes the target
briefly before `click` / `fill` on **shared** tabs.

### `pushstate <url>`

SPA client-side navigation: if `window.next?.router?.push` exists, use it. Otherwise
`history.pushState` and dispatch `popstate`. Same-origin URLs only (`pushState` throws otherwise).
It goes through `Ctx.tab()`. It counts as navigation of the current tab, so it's allowed on shared
tabs, as `click` on a link is.

### `session list` / `session info`

```bash
bctl session list          # sessions, their current tab, owned tabs, last activity
bctl session info          # current session (--session/BCTL_SESSION): tab, label, url, frame
```

Read-only view of `state.sessions` and `state.tabs`. `--json` mirrors upstream field names where
they apply. Skip upstream's `session id --scope worktree`: it needs the CLI's working directory
logic, which belongs to the agent (it can name its own session).

### XPath selectors

Upstream accepts XPath wherever it accepts a selector (`click "//button[@type='submit']"`). In
`dom.ts` `resolve`, treat targets that start with `/` or `(` as XPath
(`document.evaluate(…, FIRST_ORDERED_NODE_TYPE)`), and do the same in `get count` and `wait`.

### `wait --download [path]`

Upstream waits for a download to finish and can save it to a path. In the real browser, downloads go
to the user's Downloads folder, and the `downloads` permission would be a manifest change.
Proposed: `wait --download` waits for the next download **started by a controlled tab**
(`chrome.downloads.onCreated` / `onChanged`) and prints its final path. `[path]` copies the file
there (CLI `files`). It needs the `downloads` permission, which widens what the extension can see,
so it gets its own security note. It's lower priority than the rest of this page.

## Impact

- `cli/skills/core/references/commands.md`, the SKILL summary, and `bctl help` groups.
- Activity log: none of these carry user-typed text. `pushstate <url>` logs the URL, as `open`
  does.
- Risk: Low.

## Open questions

- Should `highlight` stay on until cleared (upstream behaviour unknown) or fade out on a timer?
