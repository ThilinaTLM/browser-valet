# bctl commands

```
open [url]   back   forward   reload   close
tab [list | new [--label L] [url] | <tN|label> | close [tN|label]]
snapshot [-i] [-c] [-d N] [-s <selector>] [-u] [--delta] [--full] [@ref]   # --json: {origin,title,refs,removedRefs,snapshot}
click <t> [--new-tab] [--right]   dblclick <t>   hover <t>   focus <t>
fill <t> <text>   type <t> <text>   press <key>   keydown <key>   keyup <key>
keyboard type|inserttext <text>   check <t>   uncheck <t>   select <t> <value...>
scroll [up|down|left|right] [px] [--selector <t>]   scrollintoview <t>
drag <src> <dst>   upload <t> <files...>
mouse move <x> <y> [--duration ms] [--steps n]   mouse down|up [left|right|middle]   mouse wheel <dy> [dx]
highlight <t>   pushstate <url>   session list|info
find role|text|label|placeholder|alt|title|testid <value> <action> [value] [--name n] [--exact]
find first|last <selector> <action> [value]   find nth <n> <selector> <action> [value]
get text|html|value|attr|title|url|count|box [t] [attr]   get styles <t> [prop...] [--all]   is visible|enabled|checked <t>
wait <t|ms> [--state visible|hidden|attached|detached] | --text s | --url glob | --load s | --fn js
read [url] [--outline] [--filter <text>] [--max-output <chars>]
screenshot [path] [--full] [--annotate] [--if-changed] [--threshold <0-1>]
eval <js> | eval -b <base64> | eval --stdin
batch [--bail] [--omit-command] "<cmd>" "<cmd>" … | batch --stdin   # one command per line
pdf <path> [--landscape] [--background]   set viewport <w> <h> [scale] | reset
set media [dark|light] [reduced-motion] | reset   (set: agent tabs only)
dialog status|accept [text]|dismiss   console [--clear]   errors [--clear]
network requests [--filter <text>] [--type xhr,fetch,document] [--method <m>] [--status 200|2xx|400-499] [--clear]
network request <id>
```

`<t>` is a ref (`@e3`), a CSS selector, or an XPath (starts with `/` or `(`, e.g. `//button[@type='submit']`).
`get styles` prints a curated set (`--all` for every computed property, or name the properties).
`highlight` outlines the element for 3 s. `pushstate` does client-side navigation (same origin only).
`mouse` is for canvases, maps and sliders; on a background tab `mouse wheel` scrolls by script. Global flags: `--json`, `--session <name>`,
`--timeout <ms>` (default 25000). `bctl <command> --help` shows details and examples.

`batch` runs the items in order (quotes and backslashes like a shell, nothing expanded). Text output is each item's output; failures
go to stderr and the exit code is 1 if any failed (`--bail` stops at the first). `--json` prints a top-level array of
`{command, success, result, error}` (`--omit-command`: `index` instead of `command`). A confirm/prompt dialog ends the batch.
Not allowed inside a batch: `batch`, `--session`, `--stdin`; `--timeout` applies per item.

`--json` output: `{success, data, error}`, plus `code` on failures (list in SKILL.md). `data` follows agent-browser:
actions echo their target (`click` → `{clicked:"@e3"}`, `fill` → `{filled}`, `press` → `{pressed}`, …), page reads add
`origin`, `get attr|value` → `{value}`, `get count` → `{count,selector}`, `console` → `{messages:[{type,text,args}]}`,
`errors` → `{errors:[{text,line,column,url}]}`, `dialog status` → `{hasDialog,type,message,defaultPrompt}`,
`tab` → `{tabs:[{tabId,label,title,url,active,controlled,pending,…}]}`, `wait --url` → `{url}`, `wait --text` → `{text}`.

