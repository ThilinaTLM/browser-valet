---
name: derive-client
description: Build a standalone API client or CLI for a website from the traffic its own pages send, using `bvl network requests` in the user's logged-in browser. Use when asked to script, wrap or reverse-engineer a site's first-party JSON API. Credentials are never exported; the client reads them from config the user provides.
allowed-tools: Bash(bvl:*)
---

# derive-client — derive an API client from observed traffic

Drive the real site in the user's browser, watch the JSON calls its own front end makes, infer
each endpoint's request and response shape, then write a small client (script, library or CLI)
and check it against the live API. Read `bvl skills get core` first (loop, sessions, consent).

Inspired by the `derive-client` skill of [agent-browser](https://github.com/vercel-labs/agent-browser)
(Apache-2.0); rewritten for bvl, which has no HAR export.

## What bvl will and will not give you

- **Credentials are redacted by design.** `Cookie`, `Set-Cookie`, `Authorization`, API-key and
  CSRF headers, token-like query values, secret fields in request bodies (password, token,
  secret, OTP…) and token fields in JSON responses all show as `[redacted]`. There is no flag to
  reveal them, and bvl has no `cookies`, `state save` or storage export. Do not try to get them
  with `eval` (`document.cookie`, `localStorage`) either: that would copy the user's session into
  your context and files, and `HttpOnly` cookies are out of reach anyway.
- Redaction is name-based and not exhaustive: a field such as `api_token` in a response body may
  still show its value (seen in the walkthrough). If you see a live-looking secret, do not copy it
  into notes, code or the report; use a placeholder.
- So **the generated client takes credentials from configuration the user provides**: an
  environment variable (for example `EXAMPLE_API_TOKEN`) or a token they paste into a local,
  git-ignored config file. Describe where they find it (their account's API-token page, or "ask
  me and I'll tell you what to copy"), never fill it in yourself.
- Bodies are text only, at most 32 KB, and cut off beyond that (`bodyTruncated: true` in
  `--json`, plus a truncation line). Enough to infer shapes; for long lists treat the fields
  you see as a sample and mark optional ones as such.
- Each tab keeps the last 500 requests in memory. The log is dropped when the debugger session
  ends: control revoked, tab closed, or a navigation that swaps renderers. Recording starts only
  at the first `network` command on the tab, so start it *before* the flow.

## 1. Record

```bash
export BVL_SESSION=derive-example
bvl open https://app.example.com/            # your own agent tab; the user is logged in
bvl network requests --clear                 # starts recording (first call prints a notice)
bvl open https://app.example.com/notes       # or reload: load-time calls are only seen now
bvl snapshot -i
```

Then drive **one flow at a time** (list, search, open item, create, edit, delete, paginate), and
after each flow, before the next one, read what it produced:

```bash
bvl network requests --type xhr,fetch                    # all API-looking calls
bvl network requests --type xhr,fetch --method POST      # writes only
bvl network requests --filter /api/ --status 400-599     # failures worth knowing about
bvl network requests --type xhr,fetch --json > notes/flow-list.json
```

`--json` gives `data.requests[]` with `requestId`, `method`, `url`, `resourceType`, `status`,
`mimeType`, `size` (ids look like `504022.3`; `--json` also works after the id: `network request <id> --json`). Save findings to a notes file as you go (endpoint, method, query params,
body and response fields, pagination, status codes); do not rely on the buffer surviving.

Safety: this is the user's real account. Exercising **write** flows (create, edit, delete) changes
real data. Only do it with the user's go-ahead, preferably on a throwaway item you create yourself
and delete afterwards. Read-only flows are enough for a read-only client. Consider
`--allowed-domains <app host>` while exploring.

## 2. Identify the API

From `network requests --type xhr,fetch`:

1. Pick the first-party API origin and prefix (`/api/v1/`, `/graphql`, `api.example.com`).
   Ignore analytics, ads, CDNs and third-party widgets.
2. Group by method + path template (`/api/v1/notes/123` → `/api/v1/notes/{id}`).
3. Note static headers a client must send (`Accept`, `Content-Type`, versioning headers such as
   `X-Api-Version`). Do not copy auth headers: they are `[redacted]` and come from config.
4. Note the auth scheme from the *shape* (`Authorization: [redacted]` = bearer or similar,
   `Cookie: [redacted]` = session cookie, CSRF header present = send it too). If it is unclear,
   ask the user how they authenticate to the API (token page, cookie name).
5. Note GraphQL separately: one endpoint, shape lives in the request body's `query` and
   `variables`.

## 3. Extract shapes

For each endpoint, once:

```bash
bvl network request <id>
bvl network request <id> --json    # data.postData, data.body, data.responseHeaders, data.bodyTruncated
```

Record: path and query parameters (which vary between calls, which are fixed), request body
fields and types, response fields and types (`null` vs absent, arrays vs objects), pagination
(`cursor`, `next`, `page`, `Link` header), error shape (use a 4xx you saw, or trigger one safely
with an invalid, read-only request), rate limits and content types. Compare two or more calls of
the same endpoint to find which fields are optional. Fields shown as `[redacted]` are secret
values: model them as strings supplied by the caller or ignored; never invent them.

Request and response bodies may hold the user's personal data. Keep examples in your notes and in
the generated code synthetic (`"title": "Example note"`).

## 4. Generate the client

Ask the user which language and form (Python module, TypeScript, shell CLI with subcommands);
default to the language of the project you are in. Include:

- One function or subcommand per endpoint with typed parameters and a docstring naming the
  observed method and path.
- A single `request()` helper: base URL from config, `Accept`/`Content-Type`, timeouts, retries
  on 429/5xx with backoff, JSON decode, errors that carry status and body.
- **Credentials from the environment or a config file only**, read once at start, with a clear
  error when missing: `Set EXAMPLE_API_TOKEN (copy it from Settings → API in the app)`. Never
  print, log or commit it. Add the config file to `.gitignore`.
- Pagination helpers if the API paginates.
- A README snippet: required config, example calls, and "derived from observed traffic; not an
  official API; may change".

Prefer read operations. Include write operations only if you actually observed them, and make
destructive ones require an explicit flag.

## 5. Verify

Verification calls use **the user's own credentials, outside bvl**: the user (or their shell)
exports the token and runs the client. Ask them to run it, or to confirm that you may run it
with the variable they have set. Do not obtain the token yourself.

1. Run every read endpoint and compare the live response with what you recorded: same fields,
   types and status.
2. For writes, run only against a throwaway item the user agreed to, and clean it up.
3. Check the error paths: missing/invalid token (expect 401/403 and your clear message), a missing
   item (404).
4. Fix mismatches and rerun. Report which endpoints are verified, which were not and why.

## Commands used (all exist in bvl)

`open`, `reload`, `snapshot -i`, `click`, `fill`, `network requests [--filter --type --method
--status --clear]`, `network request <id>`, `--json`. Not available by design: HAR export,
`cookies`, `state save`, network interception.
