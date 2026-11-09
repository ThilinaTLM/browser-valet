# `read`: page text as markdown

**Status:** Draft · **Area:** automation

## Problem

For docs, articles and long text pages, a snapshot is the wrong tool: it's an accessibility tree
with refs, verbose for prose and missing structure such as code blocks. agent-browser has `read`,
which returns readable text (markdown), with `--outline` (headings only) and `--filter <text>` (only
the matching sections).

## Upstream behaviour

```bash
agent-browser read                         # rendered DOM of the active tab
agent-browser read <url>                   # fetch over HTTP, prefer markdown, no Chrome
agent-browser read <url> --outline
agent-browser read <url> --filter auth
# also: --raw, --require-md, --llms <index|full>, --max-output, --content-boundaries
```

Observed output for the active tab ([observed-output.md](agent-browser-parity/observed-output.md)):
plain markdown (headings, lists, fenced code), link text kept and URLs dropped. `--outline` prints
`# Outline`, `Source: <url>` and a nested heading list. `--filter auth` prints only the matching
heading section. The extraction includes nav text (`Sidebar A`); we can do better by preferring
`main`/`article`.

## Design

- `read` (no URL): extract from the session's current tab, through `Ctx.tab()` as usual.
- `read <url>`: navigate the session's tab like `open <url>` (so it follows the `open` rules: it
  never navigates a shared tab and opens an agent tab instead), wait for load, then extract. Why not
  fetch over HTTP: the CLI must stay thin (principle 3), and a fetch from the service worker would
  also send the user's cookies without a visible tab. A real tab is visible in the activity log and
  in the tab strip.
- **Extraction:** run a bundled extractor in the page with `Runtime.evaluate`: pick the main content
  (`main`, `article`, or a Readability-style score), then convert it to markdown (headings, lists,
  links, code blocks, tables). Prefer a small vendored library with a compatible licence (e.g.
  Mozilla Readability, Apache-2.0, plus a minimal HTML→markdown step) over custom heuristics.
- `--outline`: headings only, indented by level. `--filter <text>`: sections (a heading plus its
  content up to the next heading of the same or higher level) whose heading or body contains the
  text, case-insensitive.
- `--max-output <chars>`: truncate with a clear `… (truncated, N more chars)` marker. If the
  [guardrails](agent-guardrails.md) proposal adds a global `--max-output`, use that instead.

## Not included

`--llms` (`/llms.txt` discovery) and `--require-md` (content negotiation) need an HTTP fetch. Leave
them out unless a fetch path is agreed on later.

## Open questions

- Bundle size budget for the extractor in the extension?
- Should `read` also inline same-origin iframes, as snapshot does? (Default: no.)
