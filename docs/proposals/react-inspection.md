# React inspection: `react tree|inspect|renders|suspense`

**Status:** Draft · **Labels:** feature, automation · **Issue:** #26

## Problem

Developers using agents on React apps (dev servers, staging) want component-level answers: the
tree, a component's props/hooks/state, what re-rendered, which Suspense boundaries are dynamic.
agent-browser (0.41.2) provides them behind `open --enable react-devtools <url>`, which installs the
React DevTools global hook before page scripts run:

```
open --enable react-devtools <url>
react tree | react inspect <fiberId> | react renders start | react renders stop [--json]
react suspense [--only-dynamic] [--json]
```

bvl lists `react *` in Settled directions because the hook has to exist **before** the page
loads, which needs an init script, and init scripts (`addinitscript`) are excluded. This proposal
asks for one narrow exception.

## Design

### Hook installation

- `open --enable react-devtools <url>` (same flag name and `AGENT_BROWSER_ENABLE`-style
  spelling as upstream; env var `BVL_ENABLE`) on **agent tabs only**. The extension calls
  `Page.addScriptToEvaluateOnNewDocument` (`runImmediately: true`) with the **built-in, vetted** hook
  script bundled in the extension, then navigates. A shared tab, or a tab the agent did not open
  in this call, is refused: `--enable` on a shared tab fails with "react-devtools needs a new
  agent tab" because we would need to reload a page the user is using, and `open <url>` never
  navigates a shared tab anyway.
- The script identifier is stored per tab and **removed** (`Page.removeScriptToEvaluateOnNewDocument`)
  on revoke, tab close, `close`, debugger detach, or `react disable`. The hook only exists while
  bvl's debugger session is attached; the page's next load after detach has no hook. If the
  worker restarts, the identifier is lost with the session; Chrome removes the script when the
  debugger detaches, so nothing persists in the profile.
- The script is not user-provided: no argument can alter it. `addinitscript`/`--init-script`
  stay excluded.
- Without the hook the commands answer: `react: no React hook on this page. Reopen it with
  open --enable react-devtools <url> (agent tab).`

### Reusing an existing hook (React DevTools extension)

If the user has the React DevTools browser extension, `__REACT_DEVTOOLS_GLOBAL_HOOK__` already exists
in every page. Reading it with `Runtime.evaluate` would need no injection and would work on shared
tabs. **Recommendation: not in the first version.** Reasons: (1) walking fibers on a shared tab
exposes component props and state, which hold app data beyond what snapshot and `read` show
(auth tokens in context, form state); it is a new read capability and needs the security review
and user sign-off required for relaxing consent; (2) the hook's shape differs by DevTools version.
Revisit later as a separate, opt-in step: allowed only on tabs with an existing grant (so no
new consent bypass), with the same redaction rules as below.

### Reading the tree

- Evaluate in the page's main world (where the hook lives) with `Runtime.evaluate`; return plain
  JSON. Walk fibers from `hook.getFiberRoots(rendererId)` for every renderer.
- `react tree`: indented component list with fiber ids, as upstream. Verify text and ids
  against the binary on a fixture. Host elements are skipped as upstream does; ids are stable
  within one page load (assigned by a WeakMap in the hook, not by order).
- `react inspect <id>`: props, hooks (with names where available), state, source location.
  Serialisation has depth ≤ 4, string ≤ 500 chars, array/object entries ≤ 50, functions as
  `ƒ name`, DOM nodes and cycles as markers, and a total cap (≈ 64 KB, then `truncated`).
- `react renders start|stop [--json]`: wrap `onCommitFiberRoot` and count renders per component with
  durations and "why" (props/state/hooks/parent). Wrapping happens on the hook object we installed
  (never on a page-owned object). Stop restores it. Auto-stop after 60 s.
- `react suspense [--only-dynamic] [--json]`: classify boundaries as upstream does.

### Redaction (needed because of props and state)

`react inspect` and `renders` can surface secrets held in props/state. Rules:

- Values under keys that match `password|passwd|secret|token|authorization|cookie|api[-_]?key|
  credential` are replaced by `[redacted]` (same list as the network observation redaction in
  [security.md](../architecture/security.md); reuse it).
- `<input type=password>` values are never read.
- The activity log records the command and the fiber id, not output.
- This is best effort. Agents that need exact values can use `eval` as today.

### Code source

- The hook: write a minimal one (`renderers` map, `supportsFiber`, `inject`, `onCommitFiberRoot`,
  `getFiberRoots`, `checkDCE`) following the public contract. React DevTools' `installHook`
  (react-devtools-shared, MIT) is the reference; copy only with the license notice kept in
  `THIRD_PARTY`.
- Upstream agent-browser's own implementation: check its license before reading or reusing
  (the binary is distributed by Vercel; do not copy from it unless licensed permissively).
  Recommendation: clean-room from React's public hook contract and MIT DevTools.
- Size: a small hook plus the fiber walker, expected < 30 KB, loaded from the extension package
  on demand like `read-extractor.js`, so it stays out of the service-worker bundle.

### Risks

- Page behaviour changes: React sees a DevTools hook and switches on development-time
  profiling/`__REACT_DEVTOOLS_GLOBAL_HOOK__` code paths (e.g. `isDisabled`, extra warnings). The
  same applies to any user with DevTools, but only agent tabs are affected.
- Production builds don't expose component names (minified) or `onCommitFiberRoot` timing;
  commands print what exists and a hint.
- Hidden tab: no rendering without frames; React work scheduled with `requestAnimationFrame` or
  `MessageChannel` may lag; use `prime` as `wait` does.
- Next.js/RSC and multiple roots/renderers: walk all renderers; roots inside iframes need the
  child session (out of scope for v1, say so in the output).

## Answers to the issue's questions

- *Is a vetted built-in pre-load script on agent tabs an acceptable exception to "no init
  scripts"?* Yes, narrowly: agent tabs only, one bundled script, not user-supplied, removed on
  detach/revoke, listed in Settled directions as the single exception ("`--enable react-devtools`
  installs the built-in hook; no arbitrary init scripts"). It does not touch the profile and does
  not change what servers see (no network or storage change). Needs user sign-off since it
  relaxes a Settled direction.
- *Reuse an existing DevTools hook on shared tabs?* Not in v1 (security review needed, above).
  Possibly later as an opt-in, grant-gated read.

## Test plan

- Unit: serialiser limits and redaction, fiber id stability, error text without hook.
- E2E: a fixture React app (a vendored production-free React build under
  `extension/test/e2e/fixtures/`, no CDN) opened with `--enable react-devtools` on a hidden agent
  tab: `react tree` lists components with ids; `react inspect <id>` shows props and state, with a
  `token` prop redacted; `react renders start/stop` after a click reports the re-rendered
  component; on a shared tab `--enable` is refused; after `close`/revoke the script is removed
  (a reload shows no hook).
- Compare tree and inspect text against `agent-browser 0.41.2` on the same fixture and note
  deviations in the PR.

## Priority

Low to medium; useful to web developers only. Large effort; ship `tree` and `inspect` first,
`renders` and `suspense` after.

## Docs to update when built

`cli/skills/core/SKILL.md`, `references/commands.md`, `automation.md`, `README.md` (Settled
directions: narrow the `react *` and init-script entries), `security.md` (the exception and
redaction).
