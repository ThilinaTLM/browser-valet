# Step timeline: `timeline start|stop|status`

**Status:** Draft · **Labels:** feature, automation · **Issue:** #20

## Problem

An agent (or the human reviewing its work) wants the whole flow in one image: what the page looked
like after each step, which element was acted on, and what changed. agent-browser gets this from
`record start <file> --contact-sheet`: keyframes captured from a video pipeline, merged into one PNG
with timestamps. `record` is a Settled direction (see #24), and it needs
ffmpeg, which the thin CLI must not depend on. A step timeline built from per-action screenshots
gives most of the value with no video, no new permission and no CLI work.

## Design

### Commands

```
timeline start [--threshold 0.05] [--max-frames 50]
timeline stop [path] [--columns 3] [--frames <dir>]
timeline status
```

- Session-scoped. A timeline records the session's current controlled tab and follows
  `tab <tN>` switches. One timeline per session; `start` while running restarts it with a warning.
- `stop` writes the contact sheet PNG through `res.files` (default `./timeline-<ts>.png`), and with
  `--frames <dir>` each frame as a JPEG. `status` prints running/stopped, frame count and bytes used.
- If `record start --contact-sheet` is ever built (see #24), it maps onto
  this code.

### Capture

- After each page-changing command (`click`, `dblclick`, `fill`, `type`, `press`, `select`,
  `check`, `uncheck`, `upload`, `drag`, `open`, `back`/`forward`/`reload`, `pushstate`, `scroll`)
  `execute` takes a viewport capture through the existing hidden-tab-safe `viewport()` path
  (clip capture, no `prime` before it; see [automation.md](../architecture/automation.md)).
  Downscaled to ≤ 800 px wide, JPEG q≈60.
- The capture runs after the result is formed, so the command's own latency does not change, but it
  finishes before the next command on that tab starts (per-tab queue). Expected cost 30–80 ms per
  step; measure in the spike below.
- Explicit `screenshot` calls during a timeline also become frames (the image already exists).
- A failed command is also a frame (captioned `✗`), because the failure state is the most useful
  frame for a reviewer.

### Keyframe selection

- Compare with the last kept frame using `capture-compare.ts` (same downscale and per-channel
  tolerance as `screenshot --if-changed`). Keep when `ratio > threshold`. Always keep the first
  and the last frame (taken at `stop`).
- Dropped frames still contribute their action to the next kept frame's caption (`+2 steps`), so
  the sheet doesn't hide that something happened.
- At `--max-frames`, drop the frame with the smallest change ratio among the middle frames.

### Annotation

Drawn in an `OffscreenCanvas` at `stop`; nothing is injected into the page and the page's pixels
are never altered at capture time.

- **Red box** around the action's target, from the same box `clickPoint`/resolve already computed
  (viewport coordinates, scaled). Commands without a target (`open`, `press`) get no box.
- **Orange outline** around changed regions: compare against the previous kept frame on a coarse
  grid (e.g. 16 px cells), cluster adjacent changed cells, draw the bounding boxes (cap at ~5, merge
  the rest into one).
- **Caption** below each tile: `#3 · 00:12.4 · click @e5 → /checkout`. The caption **MUST** be built
  with `describe()`, the same redaction as the activity log, so typed text never appears
  (`fill #pw •••`). URLs show path only (no query or fragment), because these often carry tokens.
- Sheet: grid with `--columns` (default 3), a header with start time, tab origin and frame count.
  Tile size follows the downscaled frame; a 3-column sheet of 800 px frames is ≈ 2400 px wide.
  Cap the sheet at 16000 px tall and shrink the tiles beyond that.

### Storage and lifetime

- Frames must survive service-worker restarts between commands, so they are kept in
  `chrome.storage.session` (memory only, never written to disk), as a separate key from `state`
  so the handoff and the activity log don't carry image data. Byte budget ≈ 8 MB for the whole
  extension (session storage allows 10 MB; leave room for `state`). When full, drop middle frames
  first.
- **Not** IndexedDB or `chrome.storage.local`: they would put page content on disk in the user's
  profile (principle 6).
- A self-update reload (handoff) discards the timeline; `status` says so. Handoff copies to
  `storage.local`, which would write page images to disk, so images are never part of it.
- Revoke, tab close or `close` of the recorded tab stops and discards the timeline of every session
  recording it. Nothing is written anywhere until `timeline stop`.

### Security

- Only controlled tabs (`ctx.tab()`); a shared tab can be recorded because the grant already allows
  `screenshot`. A tab the session switches to without a grant is never captured.
- Frames contain whatever the page shows, including secrets typed into visible fields. This is
  the same exposure as `screenshot`, but it is automatic. Mitigations: caption redaction as above,
  a note in [security.md](../architecture/security.md) that the extension holds screenshots in session
  storage while a timeline runs, and the toolbar badge/popup showing "recording" on that tab
  (so the user can see it and press Stop, which revokes).
- Password fields (`input[type=password]`) are visible as dots in screenshots already; no extra
  masking is planned.

## Answers to the issue's questions

- *Extra capture cost after each action?* Accept ~30–80 ms; do it after the result is formed and
  keep it off the path when no timeline runs (a single `if (session.timeline)` check). Confirm with
  the spike numbers.
- *Do `screenshot` calls become frames?* Yes.
- *Settled directions wording:* when accepted, replace "video/trace" with "video (see
  the recording proposal)/trace" and add: "A step timeline (`timeline`) exists; it stores screenshots only in
  session storage."

## Test plan

- Unit: keyframe selection (threshold, always-first/last, max-frames eviction), caption redaction
  (`fill` of a password field never shows its text), changed-region clustering, byte-budget eviction
  with mocked `chrome.storage.session`.
- Timeline restored from storage after a simulated worker restart in the middle of a run (unit with
  mocked storage; E2E if the harness can restart the worker).
- E2E: a 5-step flow on a hidden agent tab produces a PNG with 5 captioned frames; the clicked
  elements are boxed red (sample pixels at the expected boxes).

## Priority

Medium. Cheap to build on existing capture, compare and annotate code, and it is the
reviewer-facing half of recording.

## Open questions

- Is storing up to ~8 MB of page screenshots in session storage acceptable without a per-start
  consent step? (Recommendation: yes; the tab is already granted and the popup shows the state.)
- Should a timeline be allowed on shared tabs by default? (Recommendation: yes, same as `screenshot`.)

## Docs to update when built

`cli/skills/core/SKILL.md` and `references/commands.md`, `automation.md` (design section),
`README.md` (Settled directions), `security.md` (screenshots in session storage), `ui.md` if the
popup shows a recording indicator.
