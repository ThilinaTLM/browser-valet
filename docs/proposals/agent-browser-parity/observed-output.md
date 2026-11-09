# agent-browser 0.41.2: observed CLI output

Captured on 2026-11-09 by running `agent-browser` 0.41.2 (headless Chrome) against local fixture
pages (a login form, a docs page, and a page with a same-origin and a cross-site iframe). This is
evidence for the parity proposals. **Where the upstream skill docs and the binary disagree, the
binary wins.** The `lifecycle` object that upstream adds to every `--json` `data` has been removed
from the excerpts below. It is daemon noise and not worth copying.

## Snapshot

The docs show `@e1 [heading] "Log in"` with a `Page:`/`URL:` header. **The binary does not print
that.** It prints the same format as bctl:

```
$ agent-browser snapshot -i
- link "Home" [ref=e5]
- link "Docs" [ref=e6]
- heading "Log in" [level=1, ref=e1]
- textbox "Email " [ref=e13]
- checkbox " Remember me" [checked=true, ref=e8]
- combobox "Plan" [expanded=false, ref=e9]: Pro
  - option "Free" [ref=e18]
  - option "Pro" [selected, ref=e19]
- button "Disabled" [disabled, ref=e12]
- cell "Apple" [ref=e16]
- generic "Clickable div" [ref=e2] clickable [cursor:pointer, onclick]
- button "Confirm me" [ref=e3]
- link "Privacy Policy" [ref=e4, url=http://localhost:8731/privacy]   # with -u
```

Differences from bctl:

- **Cursor-interactive elements:** a `<div onclick … style="cursor:pointer">` gets a ref and the suffix
  `clickable [cursor:pointer, onclick]`. In `-i` mode its text is lifted into the name
  (`generic "Clickable div"`). bctl gives such a div no ref.
- **Refs are stable and monotonic:** the full snapshot, the `-i` snapshot and later snapshots of the
  same page all give the same element the same ref. Numbers are not in document order. After a
  navigation the counter **keeps rising** (refs `e40…`, `e52…`, `e67…`), so a ref from an old page
  fails with `✗ Unknown ref: e60` instead of hitting a different element. bctl renumbers from `e1`
  on every snapshot.
- **Cross-site iframes are inlined** with working refs:

  ```
  - Iframe "payment-frame" [ref=e42]
    - textbox "Card number" [ref=e46]
    - button "Pay" [ref=e47]
  ```

- `--json` data: `{ origin, refs: {eN: {name, role}}, removedRefs: [], snapshot }`.
  bctl: `{ snapshot, refs, origin, title }`.

### `--delta`

```
$ agent-browser fill @e13 "me@example.com"; agent-browser snapshot -i --delta
{
  "baseRevision": 1,
  "changes": [],
  "kind": "delta",
  "revision": 2,
  "treeChange": { "deleteCount": 1, "lines": ["- textbox \"Email \" [ref=e13]: me@example.com"], "startLine": 3 }
}
```

Further observations (0.41.2): the text for unchanged is `unchanged (revision N)`; the revision is
one counter per session that every `--delta`/`--full` call increments (plain `snapshot` does not),
baselines are per option set, a URL change (hash included) returns the full tree, and so does a
delta whose pretty JSON is not shorter than the tree. `changes` entries are `{node:{name,role},op:"add",ref:"@e5"}`,
`{op:"remove",ref}` and `{field:"name",op:"replace",ref,value}`; attribute-only changes give `changes: []`.
`startLine` is 0-based. With `--json` the delta/unchanged object is `data.snapshot`; a full result is
`data.snapshot = {kind:"full", refs, revision, tree}`. Cursor-interactive rules are in `automation.md`.

The first `--delta` prints the plain tree. Later ones print the delta as pretty JSON **even without
`--json`**. Unchanged (JSON): `"snapshot": {"baseRevision":2,"kind":"unchanged","revision":3}`.

## Screenshots

```
$ agent-browser screenshot --if-changed c.png
✓ Screenshot unchanged (revision 2, 0.0000% pixels changed)
# --json: {"changed":false,"pixelChangeRatio":0.0,"revision":3,"threshold":0.0}   (no path)

$ agent-browser screenshot --annotate ann.png
✓ Screenshot saved to ann.png
   [21] @e21 heading "Log in"
   [22] @e22 generic
   [23] @e23 button "Confirm me"
   …
# --json: annotations: [{ref, number, role, name, box:{x,y,width,height}}], path
```

`--annotate` takes a fresh snapshot (new refs) and draws red 1–2 px boxes, with a small red number
tag at the top-left of each box. The label number is the same as the ref number.

## Text output conventions

| Command | Output |
|---|---|
| `open <url>` | `✓ <title>` / `  <url>` (same as bctl) |
| `click`, `fill`, `type`, `check`, `select`, `press`, `hover`, `scroll`, `dialog accept` | `✓ Done` |
| `wait --text "Welcome back"` | `Welcome back` (prints what matched) |
| `wait --url "**/dashboard"` | `http://localhost:8731/dashboard` (prints the matched URL) |
| `wait <ms>` | `✓ Done` |
| `get title/url/text/count` | the raw value, no decoration |
| `get box @e1` | aligned `x:      8` / `y: …` / `width:` / `height:` lines |
| `get styles @e1` | **every** computed property (~450 lines). Too noisy, don't copy. |
| `get attr @e1 href` (missing attribute) | `✓ Done`. Unclear, don't copy. |
| `is visible @e1` | `true` |
| `eval` | JSON-pretty value (`"Example - Log in"`, multi-line objects, awaited promises) |
| `tab` | `→ [t1] <title> - <url>` per tab, `→` marks the current one; label shown before the title |
| `tab new --label docs <url>` | `<url>` |
| `tab close docs` | `✓ Tab [t2] closed` |
| `close` | `✓ Browser closed` |
| `console` | `[log] hello from page` |
| `errors` | prints `✗ ` with an empty message (an upstream bug); the JSON has `{text, line, column, url}` |
| `network requests` | `[<requestId>] GET <url> (Document) 200`, recorded from the start. Flags `--filter --type --method --status 200\|2xx\|400-499 --clear`. Empty: `No requests captured`; `--clear`: `✓ Request log cleared` |
| `network request <id>` | text prints only the URL (JSON has headers, `postData`, body); unknown id: `✗ Request not found` |
| `session list` | `Active sessions:` / `→ name` |

### A click that opens a confirm dialog

```
✓ Done                                          (stdout)
⚠ A JavaScript confirm dialog is blocking the page: "Sure?" — use `dialog accept` or `dialog dismiss` to resolve it   (stderr)
```

`dialog status`: `⚠ JavaScript confirm dialog is open: "Sure?"` / `  Default prompt text: ""` /
`  Use …`. JSON: `{hasDialog, type, message, defaultPrompt}`.

### Errors

```
✗ Unknown ref: e99
✗ Element not found: #nope. Verify the selector, role, or name is correct and the element exists in the DOM.
✗ No element found by text 'Nothing here'. Verify the selector, role, or name is correct and …
✗ Wait timed out after 1500ms
✗ Evaluation error: Error: bad
    at <anonymous>:1:7
Unknown command: foo                     # --json: {"error":"Unknown command: foo","success":false,"type":"unknown_command"}
Missing arguments for: click
Usage: agent-browser click <selector> [--new-tab] [--human]
```

JSON errors: `{"success":false,"data":null,"error":"…"}`. Some errors also carry a machine `type`
(`unknown_command`), and the docs mention `code: "tab_gone"` with a recovery object.

## Batch

```
$ agent-browser batch "get title" "get url" "click #nope" "get title"
Frames

http://localhost:8731/frames.html


Frames
✗ Element not found: #nope. …            (stderr; exit 1 because one item failed)

$ agent-browser --json batch "get title" "click #nope"
[{"command":["get","title"],"error":null,"result":{"title":"Frames"},"success":true},
 {"command":["click","#nope"],"error":"Element not found: …","result":null,"success":false}]
```

`--bail` stops after the first failure. JSON is a **top-level array**, not wrapped in
`{success, data}`.

## Read

```
$ agent-browser read                 # rendered DOM of the active tab, as markdown
Sidebar A

# Guide

Intro paragraph with a link.         # link text kept, URL dropped
## Auth
…```code blocks kept```…

$ agent-browser read --outline
# Outline

Source: http://localhost:8731/docs.html

- Guide
  - Auth
  - Install

$ agent-browser read --filter auth    # the matching heading section only
## Auth

Use tokens.
…
```

## Help

- `agent-browser --help`: a "Start here (for AI agents)" block pointing to `skills get core`, then
  grouped commands.
- `agent-browser <cmd> --help`: name and one-line summary, `Usage:`, a **paragraph of behaviour notes**
  (e.g. "Click … fails, instead of reporting success, when the element is hidden, disabled, or
  outside the viewport"), `Options:`, `Global Options:`, and **`Examples:`**.
- Selectors also accept **XPath** (`click "//button[@type='submit']"`).
- `wait` has `--download [path]` and documents "wait for something to disappear" with
  `--state hidden|detached`.
