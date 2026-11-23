# bvl commands

```
open [url]   back   forward   reload   close
tab [list | new [--label L] [url] | show [tN|label] | <tN|label> | close [tN|label]]
snapshot [-i] [-c] [-d N] [-s <selector>] [-u] [--delta] [--full] [@ref]   # --json: {origin,title,refs,removedRefs,snapshot}
diff snapshot [--stdin] [-s <selector>] [-c] [-d N]   # unified diff vs last snapshot or stdin baseline; --json: {diff,additions,removals,unchanged,changed}
click <t> [--new-tab] [--right] [--human]   dblclick <t> [--human]   hover <t> [--human]   focus <t>
tap <t>   swipe <up|down|left|right> [px=300] [--selector <t>] [--duration ms]   # touch events
fill <t> <text>   type <t> <text>   press <key>   keydown <key>   keyup <key>
keyboard type|inserttext <text>   check <t>   uncheck <t>   select <t> <value...>
scroll [up|down|left|right] [px] [--selector <t>]   scrollintoview <t>
drag <src> <dst> [--human]   upload <t> <files...>   # <t> may be the button that opens the chooser
mouse move <x> <y> [--duration ms] [--steps 1-240] [--human [--seed n]]   mouse down|up [left|right|middle]   mouse wheel <dy> [dx]
highlight <t>   pushstate <url>   session list|info
frame <selector|@ref|name|url|main>   # scope snapshot, selectors, get, eval, wait --fn to an iframe
find role|text|label|placeholder|alt|title|testid <value> <action> [value] [--name n] [--exact]
find first|last <selector> <action> [value]   find nth <n> <selector> <action> [value]
get text|html|value|attr|title|url|count|box [t] [attr]   get styles <t> [prop...] [--all]   is visible|enabled|checked <t>
wait <t|ms> [--state visible|hidden|attached|detached] | --text s | --url glob | --load s | --fn js
read [url] [--outline] [--filter <text>]
vitals [url]   # TTFB/FCP/LCP/CLS/INP + ratings; --json: {url,ttfb,fcp,lcp,cls,inp,ratings,notMeasurable}
a11y [url] [--tags wcag2a,wcag2aa] [-s <css>]   # axe-core audit; violations by impact, @eN for snapshot elements
screenshot [path] [--full] [--annotate] [--if-changed] [--threshold <0-1>]
   [--screenshot-format png|jpeg] [--screenshot-quality <0-100>] [--screenshot-dir <dir>]
diff screenshot [-o <file>] [-t <0-1>] [-f|--full]   # pixel diff vs the last screenshot of this tab (grey baseline, changes red); first call records the baseline, kept in memory only; --baseline <file> unsupported
eval <js> | eval -b <base64> | eval --stdin
batch [--bail] [--omit-command] "<cmd>" "<cmd>" … | batch --stdin   # one command per line
pdf <path> [--landscape] [--background]   set viewport <w> <h> [scale] | reset
set media [dark|light] [reduced-motion] | reset   set touch on|off   (set: agent tabs only)
dialog status|accept [text]|dismiss   console [--clear]   errors [--clear]
network requests [--filter <text>] [--type xhr,fetch,document] [--method <m>] [--status 200|2xx|400-499] [--clear]
network request <id>
```

`<t>` is a ref (`@e3`), a CSS selector, or an XPath (starts with `/` or `(`, e.g. `//button[@type='submit']`).
`get styles` prints a curated set (`--all` for every computed property, or name the properties).
`frame` scopes later commands to an iframe until `frame main` or a navigation; `get title|url` stay on the tab.
`highlight` outlines the element for 3 s. `pushstate` does client-side navigation (same origin only).
`mouse` is for canvases, maps and sliders; on a background tab `mouse wheel` scrolls by script.
`--human` moves the pointer along a curved, eased path from its last position (use it for hover menus, sliders and drag libraries that need intermediate `mousemove`s); `--seed n` makes the path repeatable. Background tabs deliver about one move per frame, so fewer events arrive than were sent.
Global flags: `--json`, `--session <name>`,
`--timeout <ms>` (default 25000), `--max-output <chars>`, `--content-boundaries`, `--allowed-domains <list>`, `--confirm-actions <list>`, `--screenshot-format`, `--screenshot-quality`, `--screenshot-dir` (screenshot only). `bvl <command> --help` shows details and examples.

`batch` runs the items in order (quotes and backslashes like a shell, nothing expanded). Text output is each item's output
(empty outputs are skipped); errors and warnings go to stderr labelled with the step, e.g. `✗ [2/3] click @e9: Unknown ref…`,
followed by a summary `batch: 2 of 3 steps succeeded; failed: 2 (click); skipped: 1`. The exit code is 1 if any failed
(`--bail` stops at the first). `--json` prints a top-level array of `{index, command, success, result, error, code?}`
(`--omit-command` drops `command`). A confirm/prompt dialog ends the batch.
Not allowed inside a batch: `batch`, `--session`, `--stdin`; `--timeout` applies per item.

`--json` output: `{success, data, error}`, plus `code` on failures (list in SKILL.md). `data` follows agent-browser:
actions echo their target (`click` → `{clicked:"@e3"}`, `tap` → `{tapped}`, `swipe` → `{swiped,distance}`, `fill` → `{filled}`, `press` → `{pressed}`, …), page reads add
`origin`, `get attr|value` → `{value}`, `get count` → `{count,selector}`, `console` → `{messages:[{type,text,args}]}`,
`errors` → `{errors:[{text,line,column,url}]}`, `dialog status` → `{hasDialog,type,message,defaultPrompt}`,
`tab` → `{tabs:[{tabId,label,title,url,active,controlled,pending,…}]}`, `wait --url` → `{url}`, `wait --text` → `{text}`, `a11y` → `{axeVersion,url,counts,violations,incomplete}`.
`click`, `dblclick`, `press`, `select` (and `find … click`) add `navigated:{url,title}` when they changed the page.
`open`/`back`/`forward`/`reload`/`tab new` add `loaded:false` when `--timeout` hit before the load event and `status` (HTTP) when known.
`unknown_command` errors add `suggestion` when a command name is close.

