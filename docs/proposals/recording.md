# Video recording: `record start|stop|restart`

**Status:** Draft · **Labels:** feature, automation · **Issue:** #24

## Problem

agent-browser has `record start <file.webm|mp4> [url] [--fps n] [--cursor] [--contact-sheet]`,
`record stop` and `record restart`. It pipes CDP screencast frames to ffmpeg. bvl cannot depend on
ffmpeg (the CLI stays thin, principle 3), but the browser can encode video itself. `record` is
currently a Settled direction ("heavy, not needed now"), and this document is the proposal that
the rule asks for.

## Design

### Commands

```
record start <file.webm|mp4> [url] [--fps 5] [--cursor]
record stop
record restart [url]
```

`--contact-sheet` maps onto the step timeline (#20 (step timeline)), which is built
first and shared. `record start` on a session that already records is an error; `restart` stops
and discards, then starts again. Output goes through `res.files` at `stop`; nothing is written
earlier (privacy, below).

### Frame source

The tab is usually hidden, and a hidden tab renders no frames, so `Page.startScreencast` delivers
nothing for it. Options:

| Option | Fps ceiling | Notes |
|---|---|---|
| A. Periodic `Page.captureScreenshot` through the hidden-tab clip path (`viewport()`) | ~5–10 (to measure) | Works hidden and visible. Costs CPU in the user's browser. Same path as `screenshot`. |
| B. `Page.startScreencast` + forced frames (`prime`) | frames only when something is drawn | A hidden tab draws only on `prime`; unreliable cadence and the 1×1 prime capture is known to blank the next clipped capture (automation.md). |
| C. `chrome.tabCapture` / `getDisplayMedia` | real-time | Needs the tab to be visible and a user gesture (and a new permission). Violates principle 7. |

**Recommendation: A**, default `--fps 5`, cap 10. Frames are time-stamped, so a slow capture shows
as a variable frame rate, not as a speed-up. An idle page sends the previous frame again (no
capture) when `capture-compare` says nothing changed, which makes static periods almost free.
The spike (below) measures the real ceiling on a hidden tab before anything else is built.

### Encoding

The MV3 service worker cannot host `MediaRecorder` or a canvas stream. Use an **offscreen
document** (`chrome.offscreen`; the declared `reason` must be one Chrome accepts for canvas/media
encoding without capture, e.g. `BLOBS` or `WORKERS`: to be confirmed in the spike) that:

1. receives JPEG frames with timestamps from the worker (`runtime.sendMessage`, as `ArrayBuffer`
   via a port, not base64),
2. draws them on a canvas, adds the cursor overlay,
3. encodes with `MediaRecorder(canvas.captureStream(0))` + `requestFrame()` per frame
   (webm VP8/VP9; mp4/H.264 where Chrome ≥ 126 supports it), or WebCodecs `VideoEncoder` plus a
   small muxer if `MediaRecorder` timing proves too coarse for a variable frame rate.

`.mp4` is accepted only if `MediaRecorder.isTypeSupported('video/mp4')`; otherwise the command fails
with a hint to use `.webm`. No transcoding is attempted.

### `--cursor`

Drawn on the canvas from the pointer state bvl already tracks per tab (`commands/extra.ts`: last
position, held buttons) plus click events from `execute`, as a pointer glyph and a click ripple.
Nothing is injected into the page. Upstream injects an overlay, which shows up in the page's DOM
and can break it. Caveat: commands that act by script (hidden-tab wheel, `check` via DOM) have no
real pointer, so the cursor shows the resolved target centre.

### Transport

Videos are megabytes. `res.files` sends base64 in one WebSocket message through the proxy to the
CLI. Rough size: 10 s at 5 fps VP8 is 0.5–3 MB; a 2-minute run can exceed 30 MB, which is
~40 MB of base64. Limits to check in the spike: the WebSocket max message/frame size in the proxy
and CLI (`tungstenite` defaults: 64 MiB message, 16 MiB frame), and the extension's WebSocket.

- Short term: cap a recording (default 60 s, `--max-duration`, bounded by 16 MiB of encoded
  output) so one `res` suffices and **no protocol change** is needed.
- If longer runs are wanted: chunked file messages (`file` part messages keyed by request id, with
  a final `res` listing them). That is a protocol change that must ship in the CLI, proxy and
  extension together and be added to [protocol.md](../architecture/protocol.md) and `cli/tests/relay.rs`.
  Not part of the first version.

### Lifetime

- The recorder state lives in the offscreen document, so it survives service-worker restarts. The
  worker re-attaches to it by message at startup, and the activity log gets one entry per
  command, not per frame.
- Recording ends (and the partial file is discarded unless `stop` was already called) on revoke,
  tab close, `close`, or a self-update reload. The offscreen document is closed at `stop` and when
  no recording is active.
- One recording per tab; several sessions may not record the same tab.

### Privacy and security

- Frames come only from the controlled tab (`ctx.tab()`), shared tabs included, same exposure as
  `screenshot`, but continuous. Show a "recording" indicator in the popup and badge.
- Frames live only in the offscreen document's memory until `stop`; nothing touches disk or
  `chrome.storage`. The output path is the agent's, written by the CLI, so the usual path rules
  apply.
- Typed text appears on screen exactly as the page shows it. Secrets in visible fields are
  recorded (as with screenshots). Not redacted.
- Activity log: `record start <file>` logs the command; the file path is not a secret.

### Manifest and the `offscreen` permission

`offscreen` shows no install warning, but it widens what the extension can do (a long-lived
hidden page that can run code). It should be added only when `record` ships, which changes the
manifest of every install and so must be listed in the release notes (an extension update that
adds a permission *without* a warning does not disable the extension, unlike one that adds a
warning-level permission; verify in the spike). Recommendation: acceptable, because the document
is our own bundled page with no remote code, but it needs the user's sign-off as a manifest change.

## Answers to the issue's questions

- *Is `offscreen` acceptable?* Yes, with sign-off, bundled-code only and created on demand and
  closed after use (see above).
- *Is a low-fps video worth it compared with the step timeline?* The timeline answers "what did
  the agent do" better and cheaper, and it comes first. Video is for demonstrating animations,
  transitions and timing to a human. Recommendation: build the timeline (#20); build `record` only
  if users ask for video, and then at 5 fps with a 60 s cap.

## Spike (first step)

1. Capture rate: `viewport()` clip capture on a hidden agent tab for 10 s; record fps, CPU and
   frame size. Pass bar: ≥ 5 fps on a typical page.
2. Offscreen document: create it from the worker in the E2E Chrome for Testing, encode 50
   synthetic JPEG frames with `MediaRecorder`, and check the webm plays (`ffprobe` in the test,
   dev-only) and that mp4 is supported.
3. Message limits: send a 20 MB `res.files` entry through proxy and CLI.
4. Permission update behaviour when `offscreen` is added to the manifest.

## Test plan

Unit: frame scheduling (skip when unchanged, timestamps), cap enforcement, lifecycle on
revoke/close. E2E: 10 s recording of a hidden agent tab, with clicks, produces a webm that
`ffprobe` reports as VP8/VP9 with duration ≈ 10 s, and with `--cursor` a frame sampled after a
click has red/pointer pixels at the click position.

## Priority

Low to medium; depends on #20.

## Docs to update when built

`cli/skills/core/SKILL.md`, `references/commands.md`, `automation.md`, `README.md` (Settled
directions; the `record` entry and the `video/trace` wording), `security.md`, `runtime.md`
(offscreen document, manifest), `protocol.md` (only if chunked files are added).
