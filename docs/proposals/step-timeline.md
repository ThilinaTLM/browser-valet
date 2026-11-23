# Step timeline: `timeline start|stop|status`

**Status:** Draft · **Labels:** feature, automation · **Issue:** #20

## Problem

An agent or its reviewer wants the whole flow in one image: the page after each step, the element
acted on, and what changed. agent-browser gets this from `record start <file> --contact-sheet`
(video pipeline, keyframes, `--contact-sheet-threshold`, 100-frame cap). bvl has no ffmpeg (the
thin CLI can't depend on it, see #24), but it can build the same view from per-action screenshots,
with no video and no new permission.

**Naming (principle 5):** upstream has no `timeline`; the sheet comes from `record`. Recording
(#24) is deferred and needs a permission, so `timeline` is a bvl-specific command that does not
need it. If `record start --contact-sheet` is built, it maps onto this code (with
`--contact-sheet-threshold` as an alias of `--threshold`).

## Design

```
timeline start [--threshold 0.05] [--max-frames 50]
timeline stop [path] [--columns 3] [--frames <dir>]
timeline status
```

- One timeline per session, on the session's current controlled tab; it follows `tab <tN>`
  switches to other controlled tabs. A tab the session has no grant for is never captured.
- `stop` writes the sheet through `res.files` (default `ctx.tmpPath('bvl', 'timelines',
  'timeline-<ts>.png')`, like screenshots); `--frames <dir>` also writes each frame as JPEG.
  Output cap: sheet ≤ 16000 px tall and encoded size ≤ 12 MiB (base64 ≈ 16 MiB, at the proxy's
  tungstenite default frame limit of 16 MiB; the 64 MiB message limit is not the binding one; the
  limit check is shared with the #24 spike); beyond that, tiles shrink and the sheet
  falls back to JPEG, with a warning.

### Capture

- Which commands capture: a `changesPage` flag on the `Command` entry (like `show`), not a list in
  the timeline code, so `find … click/fill`, `hover`, `mouse`, `keyboard`, `eval` and batch items
  are covered by declaring the flag where the command is defined. Navigation commands and
  actions set it; read-only ones don't.
- Only **viewport** captures become frames (the hidden-tab clip path, `viewport()`); explicit
  `screenshot` calls count only when they are viewport captures, never `--full`/element ones.
- **Ordering:** executes run concurrently (`connection.ts`), and the documented problem is that a
  clip capture overlapping the next command's `prime` comes back blank. Capture **inside** the
  command's `execute`, before its `res` is returned, under a per-tab capture lock shared with
  `screenshot` and `prime`. The cost (~30–80 ms, measure) is paid only while a timeline runs.
- Skip the capture while a dialog is open (`raceDialog`; a blocked page never answers
  `captureScreenshot`) and race every capture against a short timeout (≈ 1 s); a skipped step
  keeps its caption with `(no frame)`.
- Downscale ≤ 800 px wide, JPEG q≈60.

### Keyframes

First frame = the capture at `start` (caption `#0 start`). Keep a frame when its change ratio against the
last kept frame (`capture-compare.ts`) is `> threshold`; always keep the first and the last (taken
at `stop`). `--threshold 0` keeps every step. Dropped steps show as `+2 steps` in the next caption.
At `--max-frames`, evict the middle frame with the smallest change.

### Annotation (at `stop`, in `OffscreenCanvas`; nothing is injected)

- Red box on the action target (box already computed by `clickPoint`/resolve); none for `open`,
  `press`. Orange outlines on changed regions (coarse grid, clustered, ≤ 5).
- Caption `#3 · 00:12.4 · click @e5 → /checkout`, built with `describe()` so typed text never
  appears (`fill #pw •••`); URLs are shown as path only.
- Grid of `--columns`, header with start time, tab origin and frame count.

### Storage: memory only

`chrome.storage.session` shares its 10 MB quota with `state` (grants), and `save()` in `state.ts`
ignores write failures, so a failed write could lose a revoke and resurrect a grant after a
worker restart: a consent bypass. So frames **stay in worker memory**, like the
`screenshot --if-changed` baselines (`capture-compare.ts`; automation.md). **Decision:** a worker restart ends
the timeline (security over convenience), which replaces the issue's "survives a service-worker
restart" criterion with "frames are lost on restart and the timeline reports it". The next command says the next `timeline` command says "timeline lost (extension restarted)". Not
IndexedDB or `storage.local` (page content on disk, principle 6). Budget ≈ 32 MB in memory;
drop middle frames when full.

### Lifetime and privacy

- Revoke or close of a tab discards its frames (a multi-tab timeline keeps the other tabs'
  frames); `revokeAll` and self-update discard everything. Nothing is written until `stop`.
- Frames show what the page shows, as `screenshot` does, but automatically. The popup shows
  "recording" on the tab; note it in [security.md](../architecture/security.md) (screenshots held in
  memory while a timeline runs).

## Settled directions

Add one line only: a step timeline exists and keeps screenshots in memory. The `record`/`video`
wording belongs to #24.

## Test plan

Unit: keyframe rules (threshold, first/last, eviction), caption redaction, region clustering, lock
ordering. E2E: a 5-step flow on a hidden agent tab with `--threshold 0` gives a sheet with 6 tiles
(start + 5), clicked elements boxed red; `fill` of a password field never appears in captions;
a worker restart reports the timeline as lost.

## Priority

Medium: reuses capture, compare and annotate code.

## Docs to update when built

`cli/skills/core/SKILL.md`, `references/commands.md`, `automation.md`, `README.md`, `security.md`, `ui.md` (recording indicator in the popup).
