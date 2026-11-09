# Snapshot parity: clickable non-semantic elements and JSON fields

**Status:** Draft · **Area:** automation

## Problem

Our snapshot line format already matches the agent-browser binary (`- role "name" [attrs, ref=eN]`).
Note that the upstream skill docs show a different `@e1 [tag]` format that the binary doesn't
print; see [observed-output.md](agent-browser-parity/observed-output.md). Two real gaps remain:

1. **Clickable `div`s and `span`s get no ref.** Many real apps (and most of the user's logged-in
   SaaS) use `<div onclick>` or `cursor: pointer` elements without an ARIA role. They are generic in
   the AX tree, so `snapshot -i` doesn't list them and the agent falls back to guessing CSS
   selectors. Upstream gives them a ref:

   ```
   - generic "Clickable div" [ref=e2] clickable [cursor:pointer, onclick]
   ```

2. **`--json` shape differs:** upstream returns `{ origin, refs, removedRefs, snapshot }`, while we
   return `{ snapshot, refs, origin, title }`. `removedRefs` matters once refs are stable (see
   [snapshot-delta.md](snapshot-delta.md)).

## Current state

`snapshot.ts`: a node is interactive if its AX role is in `INTERACTIVE` or it is `focusable`.
Generic nodes without a name are flattened (`FLATTEN_UNNAMED`).

## Design

### Cursor-interactive detection

- After fetching the AX tree, run one `Runtime.evaluate` in the page that collects elements which are
  not natively interactive but have `cursor: pointer` computed style (not inherited from an
  interactive ancestor), an `onclick` property or attribute, or `tabindex >= 0`. Return their
  `backendNodeId`s with `DOM.describeNode` on the returned objects, or use `DOM.querySelectorAll` +
  `DOM.getAttributes` / `CSS.getComputedStyleForNode`. Choose whichever is cheaper on large pages,
  and cap the count (e.g. 500).
- Mark the matching AX nodes as interactive, give them a ref, and add the upstream suffix
  `clickable [<reasons>]` with reasons from `cursor:pointer`, `onclick`, `tabindex`.
- In `-i` mode, when such a node has no name, lift its visible text (trimmed, ≤ 150 chars) into the
  name, as upstream does.
- Listeners added with `addEventListener` can't be seen from the page. Only
  `DOMDebugger.getEventListeners` sees them, and that is too slow for every node, so leave them out.
  `cursor: pointer` catches most of them.

### JSON

Return `{ origin, title, refs, removedRefs, snapshot }`. Keep `title`, since it's useful and
harmless. `removedRefs` lists refs that were known before this snapshot and are gone now (empty until
stable refs land).

## Impact

- `snapshot.ts`, `cli/skills/core/` (mention `clickable`), automation.md (Snapshot and refs).
- Risk: Low–Medium. It adds lines to `-i` output, so check the token cost on a heavy page (Gmail, Jira).

## Open questions

- Should cursor-pointer detection be skipped inside elements that already have a ref (e.g. a span
  inside a link)? Upstream appears to skip inherited cursors; confirm on a fixture.
