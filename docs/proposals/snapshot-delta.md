# Stable refs and `snapshot --delta`

**Status:** Draft · **Area:** automation

## Problem

1. **Refs are renumbered on every snapshot.** `snapshot()` assigns `e1…eN` in walk order each time.
   After a re-snapshot, or on a new page, `@e7` can silently point to a **different** element. In
   the user's real, logged-in browser, clicking the wrong element is the worst failure mode.
2. **Every re-snapshot sends the whole tree**, which costs a lot of tokens on long tasks.

agent-browser 0.41.2 solves both (see
[observed-output.md](agent-browser-parity/observed-output.md)):

- Refs are **stable** within a page: the same element keeps its ref across full, `-i` and later
  snapshots.
- The counter is **monotonic per session**: after navigating, new refs continue upwards (`e40…`,
  `e52…`), so an old ref fails with `Unknown ref: e60` instead of matching something new.
- `snapshot --delta`: the first call prints the tree. Later calls return `unchanged` or a line
  splice.

## Design

### 1. Stable, monotonic refs — implemented, see automation.md (do first; useful without delta)

- Per tab: `backendNodeId → ref` map, plus a per-session counter `nextRef`.
- At each snapshot, nodes already in the map keep their ref and new nodes take `e<nextRef++>`. Refs
  whose node is gone are dropped and reported in `removedRefs`.
- On a cross-document navigation of the main frame, clear the tab's map but **keep the counter**,
  so old refs can never collide.
- `state.refs` stays the persisted source (it already survives service-worker restarts). Add
  `nextRef` per session to the state with a default for the handoff (`restoreHandoff`).
- Keep the role+name fallback in `resolveRef` for replaced nodes. It now only applies to refs from
  the current document.

### 2. `--delta` / `--full`

- Baseline: the last rendered lines and revision per `(tabId, option-key)`, **in memory only**
  (the `chrome.storage.session` quota and its rewrite-on-every-change cost rule out persisting it).
  After a service-worker restart the next `--delta` returns the full tree.
- A URL change, or a delta larger than about 50 % of the full tree, returns the full tree.
- Diff: one contiguous splice (`startLine`, `deleteCount`, `lines`), plus ref `changes`
  (`add`/`remove`/`replace`), and `baseRevision` / `revision`, as upstream.
- Output, matching upstream:
  - Full: the plain tree.
  - Delta: pretty JSON `{ baseRevision, changes, kind: "delta", revision, treeChange }`. Upstream
    prints JSON even without `--json`; we copy that so agents' parsers work unchanged.
  - Unchanged: upstream's text form wasn't captured. Print
    `{ "baseRevision": N, "kind": "unchanged", "revision": N+1 }` for consistency.
  - `--json`: `data.snapshot` holds the object above.

## Impact

- `snapshot.ts`, `dom.ts` (`resolveRef`), `state.ts` (shape + handoff default), skills (explain that
  refs survive re-snapshots but not navigations; introduce `--delta`), automation.md.
- Risk: Medium (ref semantics and state shape).

## Open questions

- Should `snapshot -i` and full `snapshot` share one ref map? Upstream does (same element, same ref).
  Recommended: yes.
