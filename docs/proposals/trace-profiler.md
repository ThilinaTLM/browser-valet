# DevTools trace and CPU profile: `trace` and `profiler`

**Status:** Draft · **Labels:** feature, automation · **Issue:** #25

## Problem

"Why is this page slow?" on the user's real data (logged in, real accounts) is a question agents
can't answer from snapshots. agent-browser records DevTools traces (`trace start` /
`trace stop [path]`) and profiles (`profiler start [--categories …]` / `profiler stop [path]`) as
Trace Event JSON that opens in DevTools' Performance panel or Perfetto. They are listed under
Settled directions ("heavy, not needed now"). This proposal asks for an exception, **starting with
a spike**, because whether `chrome.debugger` allows tracing is not known.

## Spike (first step; not yet run)

The spike was **not** run for this document: the E2E Chrome for Testing build is not installed in
the authoring environment, and the check needs the built extension, a service-worker REPL and a
fixture, which was not cheap enough to do here. Do it as the first implementation step with the
E2E harness (`pnpm test:e2e` setup) and record results in this page:

1. Attach `chrome.debugger` to a fixture tab. Send `Tracing.start` with
   `{ transferMode: "ReturnAsStream", streamFormat: "json", categories: "devtools.timeline,…" }`.
   Record: does it succeed, or return "Tracing domain is not available / Not allowed"? Chrome's
   `chrome.debugger` has an allowlist of domains for extension sessions, and the Lighthouse
   extension's use of tracing is a precedent, not a guarantee.
2. If it starts: `Tracing.end`, wait for `Tracing.tracingComplete` (carries `stream`), read it with
   `IO.read` in chunks, and check the JSON opens in Perfetto (`trace_processor` or the UI).
   Also try the `Tracing.dataCollected` events path (`transferMode: ReportEvents`) and compare size
   and time.
3. Does tracing work on a **hidden** tab, and is the trace limited to that tab's renderer
   process (or does it include the whole browser's categories, which would leak other tabs)?
   `Tracing` on a page target normally traces the **whole browser process**, not only that page.
   If so this is a principle 1 problem (see Security). Inspect the events' `pid`/URLs for other
   tabs.
4. `Profiler.enable`, `Profiler.start`, interaction, `Profiler.stop` returns a `.cpuprofile`
   object; confirm it works on a hidden tab and measure size.
5. Does a second debugger client (DevTools open on the same tab) block either?

Outcomes: (a) both work and tracing is tab-scoped → build both; (b) tracing works only
browser-wide → build `profiler` only and keep `trace` Settled; (c) neither → close this proposal.

## Design

### Commands (match upstream)

```
trace start [--categories <csv>]
trace stop [path]
profiler start [--categories <csv>]
profiler stop [path]
```

- `trace` = `Tracing.start/end` (Performance-panel style trace). Default categories as upstream:
  `devtools.timeline, v8.execute, blink, blink.user_timing, latencyInfo, renderer.scheduler,
  toplevel` plus the `disabled-by-default-devtools.timeline*` and stack ones. Verify the list
  against `agent-browser` 0.41.2 in the spike.
- `profiler` = a CPU profile (upstream writes Trace Event JSON that opens in Perfetto; confirm
  the exact format in the spike) using the `Profiler` domain. If `Profiler.start/stop` only gives a
  `.cpuprofile`, wrap it as `Profile`/`ProfileChunk` trace events, or write `.cpuprofile` and say
  so. Decide from the spike; JSON field names and the `✓ Trace saved to <path>` text follow upstream.
- `stop` without a path writes `./trace-<ts>.json` in the CLI's cwd (`res.files`), like
  screenshots. The output prints the path and the event count.
- One trace or profile per tab at a time; a second `start` is an error with a hint.

### Limits

- Cap events (upstream caps at 5 M; use 1 M by default, `--max-events`) and size (encoded output
  ≤ 16 MiB until chunked files exist). When the cap is hit, tracing is ended, the result is
  flagged `truncated` and a warning printed on stderr.
- Time cap: tracing ends automatically after 60 s without `stop` (the agent forgot), and the
  data is discarded. Heavy tracing slows the user's tab and fills extension memory.
- Streaming: read with `IO.read` as the trace ends, not in `dataCollected` events piling up in
  the service worker. Large traces need chunked file messages (protocol change shared with
  #24); the first version stays under the single-message limit.

### Lifetime

- Active trace/profile state lives in the service worker memory, keyed by tab; a worker restart
  drops the debugger session and so the trace; `stop` then says "trace was lost (extension
  restarted)". That's acceptable for a debugging aid.
- Revoke, tab close, `close`, or debugger detach ends the trace and discards the data.
  Nothing is written until `stop`.

### Security

- Traces contain URLs (including query strings), script names, timings, and with some categories
  (`disabled-by-default-devtools.screenshot`, `devtools.timeline.frame`, argument-rich events)
  page content. Default categories exclude screenshots.
- **Scope check (principle 1).** If `Tracing` covers the whole browser (spike item 3), the trace
  would contain other tabs' URLs and titles, which the agent has no grant for. Then `trace` MUST
  NOT ship unless the extension filters events to the tab's `pid`/`tid` before writing (filter by
  the renderer process id and the `TracingStartedInBrowser` frame for the tab) and drops
  metadata that names other tabs. If the filter can't be made reliable, ship `profiler` only.
- Write only to the path the agent gave (through the CLI), and never log contents: the
  activity log records `trace start`/`trace stop`, no data. `--categories` is logged (not secret).
- Needs no new manifest permission (`debugger` is already declared).

## Answers to the issue's questions

- *Does `Tracing.start` work through `chrome.debugger`?* Unknown until the spike. (Sketch above.)
- *Fallback:* `Profiler.start/stop` per tab is known to work with `chrome.debugger` in general
  (DevTools-style per-target domain); verify hidden-tab behaviour.
- *Priority:* low; build `profiler` first (scoped by nature) and `trace` only if the scope check
  passes.

## Test plan

Unit: category parsing, event cap, auto-end timer, lifecycle on detach. E2E: `trace start` →
load a fixture page → `trace stop out.json`; JSON parses, has `traceEvents` with
`FunctionCall`/`RunTask`, and contains no URL of another open tab (opened in the test for that
purpose). Loading the file in Perfetto is a manual check recorded in the PR.

## Priority

Low.

## Docs to update when built

`cli/skills/core/SKILL.md`, `references/commands.md`, `automation.md`, `README.md` (Settled
directions: remove `trace`, `profiler` from the "heavy" list), `security.md` (scope rules), and
`protocol.md` if chunked files are added.
