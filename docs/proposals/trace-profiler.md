# DevTools trace and profile: `trace` and `profiler`

**Status:** Draft · **Labels:** feature, automation · **Issue:** #25

## Problem

"Why is this page slow?" on the user's real data is a question snapshots can't answer.
agent-browser 0.41.2 records Chrome traces as Trace Event JSON for DevTools' Performance panel or
Perfetto. `trace` and `profiler` are listed under Settled directions ("heavy, not needed now").

## Upstream (checked with `--help` on 0.41.2)

- `trace start` / `trace stop [path]`: a raw DevTools trace. **No `--categories`.**
- `profiler start [--categories <csv>]` / `profiler stop [path]`: also CDP **Tracing**, with
  curated default categories (`devtools.timeline`, `v8.execute`, `blink`, …), Trace Event JSON,
  5 M event cap.

Both are the Tracing domain. Neither uses the CDP `Profiler` domain (`.cpuprofile`).

## Spike result (run on Chrome for Testing 152, through the built extension's service worker)

A throwaway E2E (not committed) called `chrome.debugger` on a fresh tab:

| Check | Result |
|---|---|
| `Tracing.start` (`ReturnAsStream`, `streamFormat: json`) | **Works.** `Tracing.end` → `Tracing.tracingComplete` with a `stream` handle; `IO.read` returned 305 KB in 2 reads; valid JSON, 1474 events, contains `RunTask`. |
| `transferMode: ReportEvents` | Works (`Tracing.dataCollected` + `tracingComplete`). Stream is preferable: nothing piles up in the worker. |
| Scope | **Browser-wide.** Events came from 4 pids (browser, GPU, two renderers); the second `Tracing.start` on the same tab failed with `Tracing has already been started (possibly in another tab)`. Only one trace can run per browser, so it can also collide with the user's own DevTools. The URL of another open (same-site) tab did not appear with these categories; richer categories (`devtools.timeline` with frames, `loading`, netlog) carry URLs and titles. |
| `Profiler.enable/start/stop` | Works through `chrome.debugger` (4 nodes for a 3 M-iteration loop), tab-scoped by nature, returns a `.cpuprofile` object. |
| Hidden tab | The tab was in the background and both worked. Timers and rAF are throttled, so durations are skewed (warn). |
| Cross-site navigation while tracing | `Page.navigate` to another host did not detach in this run. The extension's own navigation path is reported to detach on a renderer swap (`navigation.ts`); **re-check in the implementation PR**. |

Not yet verified: filtering a trace down to the tab's frames, Perfetto opening the file,
a second client (DevTools open) on the same tab.

## Design

### Commands

Match upstream: `trace start|stop [path]` and `profiler start [--categories <csv>] | stop [path]`.
Both use `Tracing.start` with `ReturnAsStream`, and differ only in categories: `trace` uses a
fixed default set, `profiler` uses the curated set or `--categories`. No `Profiler`-domain
command in v1. A `.cpuprofile` command would need its own justification (it is tab-scoped, which
is its strength); suggested only as a follow-up, `profiler --cpu`.

- Output through `res.files`; with no path, write `ctx.tmpPath('bvl', 'traces', 'trace-<ts>.json')`
  like screenshots, and print the path. Size cap (default 16 MiB of JSON, within the single-`res`
  limit; chunked files only if #24 adds them). Past the cap, tracing ends, the file is flagged
  `truncated` and a warning is printed. An event cap isn't needed on top.
- Uses `ctx.tab()`: agent tabs and shared tabs both need the existing grant. Shared tabs are
  allowed only if the privacy filter below works; the user is already watching those.
- One trace per browser at a time: a failed start says so (and that DevTools may hold it).
- 60 s auto-stop discards the data (agent forgot).

### Worker restart and detach

A worker restart does **not** drop the debugger session (`cdp.ts` reuses the attachment), so a
running trace would continue ownerless, its timer lost, and the next start would fail. Keep a
per-tab `trace` marker (start time, categories) in `state` (with a default, see the handoff rule),
and on startup/revoke/close/detach end the trace and drain and discard the stream.

### Privacy (principle 1)

The trace is browser-wide, so the extension must reduce it to the granted tab **before writing**:

- Keep events from the tab's renderer pid and frame ids (`TracingStartedInBrowser` / frame
  `args.data.frame`); drop other processes' events except metadata that names no URLs. Pid
  filtering alone is insufficient: same-site tabs share a renderer process, so filter by frame
  too. Verify in the implementation PR with a second same-site tab open.
- Redact secret-like query values in URLs inside events (same `isSecretKey` rule as network
  observation, which is a MUST) and drop `title`s of other frames.
- Allowlist categories; reject `disabled-by-default-devtools.screenshot`, `netlog`, `net`,
  `disabled-by-default-network`, `*.stack` with arguments, and anything unknown unless it is on the
  allowlist. `--categories` is validated against it.
- If the filter can't be made reliable, `trace`/`profiler` stay Settled; this proposal then
  closes. Otherwise update the Settled line to drop `trace` and `profiler`, and add the
  allowlist and filter to [security.md](../architecture/security.md).
- Never log contents. The activity log shows `trace start`/`trace stop` only (`--categories`
  values are not logged unless `showFlags`).

### Permissions

None new (`debugger` is declared).

## Test plan

Unit: category allowlist, URL redaction, size cap, marker cleanup on restart. E2E: start, load a
fixture, stop; JSON parses and has `RunTask`; with a second same-site tab open, its URL is absent;
after a simulated worker restart the next `trace start` works. Perfetto loading: manual check noted
in the PR.

## Priority

Low.

## Docs to update when built

`cli/skills/core/SKILL.md`, `references/commands.md`, `automation.md`, `README.md` (Settled
directions), `security.md`.
