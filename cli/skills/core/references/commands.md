# bctl commands

```
open [url]   back   forward   reload   close
tab [list | new [--label L] [url] | <tN|label> | close [tN|label]]
snapshot [-i] [-c] [-d N] [-s <selector>] [-u] [@ref]
click <t> [--new-tab] [--right]   dblclick <t>   hover <t>   focus <t>
fill <t> <text>   type <t> <text>   press <key>   keydown <key>   keyup <key>
keyboard type|inserttext <text>   check <t>   uncheck <t>   select <t> <value...>
scroll [up|down|left|right] [px] [--selector <t>]   scrollintoview <t>
drag <src> <dst>   upload <t> <files...>
find role|text|label|placeholder|alt|title|testid <value> <action> [value] [--name n] [--exact]
find first|last <selector> <action> [value]   find nth <n> <selector> <action> [value]
get text|html|value|attr|title|url|count|box [t] [attr]   is visible|enabled|checked <t>
wait <t|ms> [--state visible|hidden|attached|detached] | --text s | --url glob | --load s | --fn js
screenshot [path] [--full]   eval <js> | eval -b <base64> | eval --stdin
dialog status|accept [text]|dismiss   console [--clear]   errors [--clear]
```

`<t>` is a ref (`@e3`) or CSS selector. Global flags: `--json`, `--session <name>`,
`--timeout <ms>` (default 25000). `bctl <command> --help` for details.

