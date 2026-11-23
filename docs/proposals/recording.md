# Video recording: `record start|stop|restart`

**Status:** Accepted design, deferred until the step timeline (#20) ships · **Labels:** feature, automation · **Issue:** #24

**Decisions (user sign-off):** the manifest `offscreen` permission is accepted for this feature.
Build order: #20 first, then this. Settled directions change when the implementation lands.

## Problem

agent-browser has `record start <path> [url] [--fps n] [--cursor] [--contact-sheet]`,
`record stop` and `record restart <path> [url] [--fps] [--cursor] [--contact-sheet]` (default 30 fps).
It pipes CDP screencast frames to ffmpeg. bvl can't rely on ffmpeg (the CLI stays thin), but the
browser can encode video itself.

## Design

```
record start <file.webm|mp4> [url] [--fps 5] [--cursor] [--max-duration 60]
record stop
record restart <file> [url] [--fps] [--cursor]
```

- Keeps upstream's path argument on `restart`. **Deviation:** default 5 fps (cap 10) instead of
  30, because hidden-tab capture can't deliver more; frames are timestamped, so a slow capture
  gives a variable frame rate, not a speed-up. `--contact-sheet` maps to #20's code.
- `[url]` navigates, so it follows `open` semantics: never a shared tab, `assertNavigable` and
  `guardNavigation` apply. Add `record` to the navigation list in
  [security.md](../architecture/security.md).
- The output path is resolved with `ctx.path` at `start`, so a cwd change later doesn't matter;
  the file is written by the CLI at `stop` only.
- Recording follows the tab it started on and ignores `tab` switches (one file = one tab).
  A tab can have one recording; several sessions can't record the same tab.

### Frames

| Option | Notes |
|---|---|
| A. Periodic clip `Page.captureScreenshot` (`viewport()` path) | Works hidden and visible. **Chosen.** ~5–10 fps to be measured. |
| B. `Page.startScreencast` + `prime` | A hidden tab draws only when forced; the 1×1 prime capture blanks the next clipped capture. |
| C. `tabCapture`/`getDisplayMedia` | Needs a visible tab and a gesture; violates principle 7. |

The loop shares #20's per-tab capture lock with `prime`/`screenshot` (a periodic capture
overlapping a prime gives blank frames), and `captureBeyondViewport` can relayout the page: the
spike measures its effect on the page. An unchanged frame (`capture-compare`) is re-sent
as a timestamp only.

### Encoding (offscreen document)

The worker can't host `MediaRecorder`. An offscreen document receives frames, draws them (plus the
cursor) on a canvas and encodes with `MediaRecorder(canvas.captureStream(0))` + `requestFrame()`
(webm; mp4 where `isTypeSupported`, else an error pointing to `.webm`), or WebCodecs if timing is
too coarse. H.264 may be missing in Chrome for Testing, so E2E asserts webm only. The Chrome floor
is already 127, past mp4 support. Offscreen `reasons` must be one Chrome accepts (`BLOBS` and
`WORKERS` are store-policy reasons; confirm in the spike).

**Messaging:** `runtime.sendMessage` is JSON-only (an `ArrayBuffer` arrives as `{}`). Send frames as base64
strings, or `postMessage` with transfer over a `MessageChannel`. Spike both.

### Cursor and worker restarts

`--cursor` draws a pointer and click ripple from the per-tab pointer state. Today that state lives
in `commands/extra.ts` and `click` doesn't update it; the pointer-state refactor (`pointer.ts`, PR
#41) updates it on click. This feature **depends on #41 being merged first**, and needs a move/click event feed to the
offscreen document (time-stamped), not only the last position. Commands acting by script (hidden wheel)
have no pointer; the cursor shows the target centre.

The capture loop and pointer state live in the worker, so a worker restart stops the loop. On
startup the worker finds the live recorder (the offscreen document holds frames and state) and
**resumes** the loop for the tab with a gap in the timeline. If the recorder is gone, `record
stop` says the recording was lost.

### Transport and size

Videos go in `res.files` as base64 in one message. Cap the **encoded** size (16 MiB, or 12 MiB if frames can't be raised), so the
base64 `res` is ≈ 22 MiB: **over** tungstenite's 16 MiB default frame limit (the 64 MiB message limit
is fine). So either cap the encoded size at ≈ 12 MiB (≈ 16 MiB base64) or raise/split frames in the
proxy, CLI and extension; the spike decides (shared with #20's output cap). At the cap recording
ends with a warning. Longer videos need chunked file messages (a protocol change in the CLI,
proxy and extension together, `protocol.md` and `cli/tests/relay.rs`); not in v1.

### Lifetime and privacy

Ends on revoke, tab close, `close`, update reload, or `--max-duration` (default 60 s), discarding
data unless stopped. The offscreen document is created on demand at `start` and closed at `stop` and whenever no recording
is active. Frames live only in its memory. Frames show what the page shows, so
visible secrets are recorded (as with screenshots); the popup and badge show "recording".

### Manifest

`offscreen` shows no install warning. Managed unpacked installs aren't disabled on permission
growth, and the manifest `key` (extension ID) **MUST** stay unchanged. List it in the release notes.

## Spike (first step)

1. Hidden-tab clip capture rate, CPU and relayout effect for 10 s.
2. Offscreen encode of 50 frames; webm plays (`ffprobe` is a dev-only tool: skip the assertion if
   absent, or check the EBML header and size instead of adding a CI dependency).
3. Frame transport (base64 vs transfer) and a 20 MB `res.files` through proxy and CLI.
4. Accepted offscreen `reasons`.

## Test plan

Unit: frame scheduling, caps, lifecycle on revoke/close, resume after restart. E2E: a 10 s
recording of a hidden agent tab produces a playable webm (header check, duration ≈ 10 s), and with
`--cursor` a frame after a click has cursor pixels at the click position.

## Docs to update when built

`cli/skills/core/SKILL.md`, `references/commands.md`, `automation.md`, `README.md` (Settled
directions), `security.md`, `runtime.md` (offscreen, manifest), `ui.md` (recording indicator),
`protocol.md` (only if chunked files).
