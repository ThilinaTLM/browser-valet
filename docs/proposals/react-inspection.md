# React inspection: `react tree|inspect|renders|suspense|disable`

**Status:** Draft; the exception below is accepted · **Labels:** feature, automation · **Issue:** #26

**Decision (user sign-off):** a narrow exception to "no init scripts" is accepted: one built-in,
vetted React DevTools hook script, installed only on agent tabs opened with `--enable
react-devtools`. `addinitscript`/`--init-script` stay excluded. The implementation PR updates
Settled directions.

## Problem

agent-browser 0.41.2 prints the React tree, inspects a fiber, records re-renders and classifies
Suspense boundaries, but needs `open --enable react-devtools <url>` so the DevTools global hook
exists before React loads:

```
open --enable react-devtools <url>
react tree | react inspect <fiberId> | react renders start|stop [--json]
react suspense [--only-dynamic] [--json]
```

## Design

### Installing the hook

- `open --enable react-devtools <url>` **always opens a fresh agent tab** (never navigates a
  shared tab or an existing one; on a shared tab, `open <url>` already opens a new agent tab, and
  `--enable` does the same). It registers the bundled script with
  `Page.addScriptToEvaluateOnNewDocument` (`runImmediately`), then navigates. `--enable` needs
  `showFlags` for the activity log. Env `BVL_ENABLE` is **dropped**: the CLI forwards only
  `BVL_SESSION` (`main.rs`), and it would need CLI and protocol changes.
- **The hook may never install** unless handled: a new tab's first URL loads via `chrome.tabs.create`
  before the debugger attaches, and a cross-site navigation swaps the renderer and detaches the
  debugger (`navigation.ts`), dropping the script. So the tab is opened on `about:blank`, attached,
  the script registered, then navigated. For hook-enabled tabs the extension **re-registers after every
  attach** (persisted flag) and reloads if the hook is missing. A spike must show this on a
  cross-site fixture.
- **Scope:** the hook applies only to the origin given to `--enable`. The script itself checks
  `location.origin` against it (baked in at registration) and **no-ops elsewhere**, because removal
  after `frameNavigated` comes too late for the next page's first script. As a cleanup, a
  cross-origin main-frame navigation also removes the script and clears the flag.
- **Persisted state:** the script identifier is stored per tab in `state` (with a default).
  A worker restart does **not** drop the attachment (`cdp.ts`), so without it `react disable`
  could not remove the script. `react disable` (new, not upstream) removes it with
  `Page.removeScriptToEvaluateOnNewDocument`; revoke, tab close, `close` and detach do too.
  Auto-stop timers for `renders` are persisted as a deadline, not an in-memory timer.
- Without a hook: `react: no React hook on this page. Reopen it with open --enable
  react-devtools <url>.`

### Coexisting with the React DevTools extension

Its hook is installed at `document_start`, and ordering against our init script is unknown. **Spike
item:** with the extension loaded, which runs first? Fallbacks: make our hook complete enough to stand
alone (renderers map, `getFiberRoots`, `onCommitFiberRoot`), or detect the existing hook and defer to it.
Until then, the rule is: Our script **never overwrites an existing
hook**: if `__REACT_DEVTOOLS_GLOBAL_HOOK__` exists, we read through it and register our listeners on it, and
`renders` wraps `onCommitFiberRoot` and restores the previous one at stop. Reading an existing hook
on **shared** tabs is not in v1: it exposes props and state beyond what `snapshot`/`read` show and needs a
separate security review and sign-off.

### Reading

Run in the main world with `Runtime.evaluate`; return plain JSON. Fiber ids come from a WeakMap in
the hook that maps both a fiber and its `alternate` to one id. `react tree` prints components with
ids, `inspect` props, hooks, state and source; `renders` counts renders with causes; `suspense`
classifies boundaries. Match upstream text and JSON on a fixture and note deviations.
Serialisation limits: depth 4, strings 500 chars, 50 entries, total ≈ 64 KB then `truncated`.
Roots in iframes are out of scope in v1.

### Redaction (best effort)

Object keys are checked with `isSecretKey` (`network.ts`: password, token, secret, API key,
credential, session, csrf, PIN, OTP, private key) and replaced by `[redacted]`, and `type=password`
values are never read. `useState` values have no keys, so a bare token string in state can't
be detected: the doc and skill say output may contain app data and is **not** guaranteed redacted.
The activity log keeps the command and fiber id, not output.

### Code source

Clean-room hook from React's public hook contract, with MIT react-devtools-shared (`installHook`) as
reference and its notice kept in `NOTICE`. agent-browser is Apache-2.0 (vercel-labs/agent-browser): if
anything is reused from it, keep its notice and license text too; the default is not to copy it.
The script loads from the extension package on demand (like `read-extractor.js`), < 30 KB.

### Risks

A hook makes React take its DevTools code paths (extra dev warnings, profiling), on agent tabs
only. Production builds are minified, so names are missing. Hidden tabs throttle rAF and
`MessageChannel`, so `wait` uses `prime`.

## Test plan

Unit: serializer limits and redaction, alternate id mapping, deadline persistence. E2E: a fixture
app using a vendored React **development** build (component names need it; no CDN): `--enable`
opens an agent tab and `tree` lists ids even after a cross-site first navigation; `inspect` shows
props and state with `token` redacted; `renders` after a click reports the component; after
`react disable` or revoke a reload has no hook; the hook is gone after a cross-origin navigation;
an existing hook isn't overwritten.

## Priority

Low to medium, large effort. Ship `tree`/`inspect`/`disable` first, then `renders` and `suspense`.

## Docs to update when built

`cli/skills/core/SKILL.md`, `references/commands.md`, `automation.md`, `README.md` (Settled
directions), `security.md` (the exception, redaction).
