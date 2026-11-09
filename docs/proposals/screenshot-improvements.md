# Screenshots: `--annotate`, `--if-changed`, `--threshold`

**Status:** Draft · **Area:** automation

## Problem

- Agents that look at images can't easily match what they see to a ref. agent-browser's
  `screenshot --annotate` draws `[N]` labels that map to `@eN`.
- Agents take screenshots after every step, even when nothing changed. agent-browser's
  `--if-changed` / `--threshold <0-1>` skips unchanged captures to save tokens.

## Current state

`screenshot [path] [--full]` in `commands/inspection.ts`: `Page.captureScreenshot`, or stitched
slices for `--full`. Files go back through `res.files`.

## Upstream behaviour

```bash
agent-browser screenshot --annotate map.png     # label [N] maps to ref @eN
agent-browser screenshot --if-changed           # skip unchanged captures
agent-browser screenshot --threshold 0.01       # ignore ≤1 % pixel change (implies --if-changed)
```

For conditional captures, the history is kept separately per tab and capture scope. JSON includes
`changed`, `revision`, `pixelChangeRatio`, `threshold`, and includes `path` only when the image
changed. The first capture for a scope always counts as changed.

Observed in 0.41.2 ([observed-output.md](agent-browser-parity/observed-output.md)):

```
✓ Screenshot unchanged (revision 2, 0.0000% pixels changed)

✓ Screenshot saved to ann.png
   [21] @e21 heading "Log in"
   [22] @e22 generic
   [23] @e23 button "Confirm me"
# --json: annotations: [{ref, number, role, name, box:{x,y,width,height}}], path
```

Annotation takes a fresh snapshot (new refs). Each ref gets a thin red box and a small red tag with
its number at the top-left. The number is the ref number.

## Design

### `--annotate`

- Take a fresh interactive snapshot first (which updates the tab's refs, as `snapshot -i` does), so
  labels and refs always agree. Print the ref list after the save line in upstream's format
  (`   [N] @eN role "name"`), so the agent gets both the image and the refs. With stable refs
  ([snapshot-delta.md](snapshot-delta.md)), existing refs keep their numbers.
- Get each ref's box with `DOM.getBoxModel`. Keep the refs that intersect the captured area.
- **Draw the labels on the image in an `OffscreenCanvas`**, not by adding overlay elements to the
  page. Why: a shared tab is the user's live page, and adding DOM there is visible and can upset the
  app (mutation observers, layout).
- With `--full`, offset the boxes by the scroll position. The stitching code already knows the page
  size.

### `--if-changed` / `--threshold`

- Keep the last capture per `(tabId, scope)`, where scope is viewport or full, in memory only (an
  `ImageBitmap` or a downscaled copy). A service-worker restart counts as "first capture".
- Compare with `getImageData` on a downscaled copy (e.g. ≤ 512 px wide) to keep it cheap. The ratio
  is the share of pixels whose difference exceeds a small tolerance.
- When unchanged: write no file, exit 0, and print upstream's line
  `✓ Screenshot unchanged (revision N, 0.0000% pixels changed)`. JSON mirrors upstream
  (`changed: false`, `revision`, `pixelChangeRatio`, `threshold`, no `path`).

## Gotchas

- Hidden agent tabs: capture already primes the tab, so annotate and diff work the same way.
- Annotated images can contain secrets from the page, just like plain screenshots. Nothing new here.

## Open questions

- Label style: copy upstream (red outline, red number tag at the top-left), so models trained on
  upstream images recognise it.
- Should `--annotate` also work with `--if-changed`? (Upstream combination unclear; default: allow.)
