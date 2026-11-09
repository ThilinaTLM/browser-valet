# Read-only network inspection: `network requests` / `network request <id>`

**Status:** Draft · **Area:** automation, security

## Problem

When an action "does nothing", agents need to see what the page sent and received: failed API
calls, 4xx/5xx, validation errors in JSON bodies. The console only shows part of that.
agent-browser has `network requests [--filter]` and `network request <id>` (full detail, including
the body).

The settled direction excludes **network interception** (routing, mocking, blocking, headers). This
proposal is about **observing** only. It changes nothing in the profile and no traffic.

## Design

```bash
bctl network requests [--filter <substr>] [--type xhr,fetch,document,…] [--status 4xx|5xx|<n>] [--clear]
bctl network request <id>          # method, url, status, timing, headers (redacted), body
```

- Text output follows upstream: one line per request,
  `[<requestId>] GET <url> (Document) 200`. Upstream records from the moment it launches, so the
  first `network requests` already lists the page load.
- Turn on `Network.enable` on attach for controlled tabs (with buffer limits such as
  `maxTotalBufferSize`). Keep a ring buffer per tab (e.g. 500 entries) of metadata in memory, as
  with console and errors in `cdp.ts`.
- Bodies are fetched on demand with `Network.getResponseBody`. They may already have been evicted,
  so say so plainly. Text bodies only by default, capped in size.
- Request bodies: `postData` capped. Treat them as secret-bearing (see below).

## Security (needs sign-off)

This is a **new capability**: the network shows things page JS can't read, most importantly
`HttpOnly` cookies and `Authorization` headers. Rules:

- **MUST** always redact `Cookie`, `Set-Cookie`, `Authorization`, `Proxy-Authorization` and other
  credential-like headers (`x-api-key`, `x-csrf-token`, …). There is no flag that reveals them.
- **SHOULD** redact obvious secrets in request bodies (`password`, `token`, `secret` keys in
  form or JSON bodies).
- Never write bodies to the activity log. Log only `network request <id>`.
- Only controlled tabs (`Ctx.tab()`), and buffers are dropped on revoke or detach.
- Update security.md (trust boundaries) and the "Not planned" wording in the proposals README:
  "network interception" stays excluded; observation is allowed.

## Cost

`Network.enable` on every controlled tab adds overhead and memory. Alternative: enable it lazily on
the first `network …` command in a session. That is simpler and has a smaller footprint, but
requests made before it are missed. Recommendation: lazy, plus a hint
("recording started; reload or repeat the action").

## Not included

HAR export (`network har`): it would write whole bodies and headers to disk. We can reconsider it
later with the same redaction rules.

## Open questions

- Lazy or always-on recording?
- Should response bodies be redacted (tokens in JSON responses, e.g. OAuth token endpoints)?
