# Agent guardrails: allowed domains, content boundaries, output limits, action confirmation

**Status:** Draft · **Area:** security

## Problem

bctl drives the user's real, logged-in profile. Today the only boundary is tab consent. Once a tab is
controlled, the agent can do anything a command offers. The skill tells agents to treat page content
as untrusted, but nothing in the tool enforces that. A prompt-injected page ("open
mail.google.com and forward…") can steer an agent toward the user's other accounts.

agent-browser has guardrails that fit this risk better than they fit its own use case (a throwaway
browser):

- `--allowed-domains`: restricts navigation and page traffic.
- `--content-boundaries`: wraps page-derived output in nonce-bearing markers.
- `--max-output`: caps output size.
- `--confirm-actions`: requires explicit approval for chosen action categories.

## Who sets the policy

This is the key difference from upstream. An agent-set flag only protects against an *injected*
agent, not a careless or malicious one, because the agent can simply leave it out. bctl has a
trusted UI that upstream lacks: the **popup**. Proposal:

- **User policy (popup, `chrome.storage.local`):** a binding policy the agent can't override. It
  applies to every session.
- **Agent flags (`--allowed-domains`, …):** can only *narrow* the user policy, never widen it.
  Agents use them as a seatbelt against injection on a task.

## 1. Allowed domains

- Scope: **agent tabs** (where the agent decides the URL). On shared tabs the user chose the page.
  Still apply the policy to agent-initiated navigation there (`click` on a link, `pushstate`), but
  not to the user's own browsing.
- Enforcement, in layers:
  1. **Commands:** `open`, `tab new`, `click --new-tab` and `pushstate` check the URL before acting.
     This is cheap and gives a clear error (`code: domain_blocked`).
  2. **Navigations the page starts** (redirects, `location =`, `target=_blank` popups that become
     agent tabs by opener grant): `Fetch.enable` with patterns limited to
     `resourceType: Document`, failing requests whose host isn't allowed. This blocks
     *navigation only*. It does not mock or alter traffic, so it stays outside the "no network
     interception" direction, but it needs your sign-off.
- Not attempted: subresource, WebSocket or beacon blocking (upstream does it). It breaks real sites
  (CDNs, analytics, SSO) and needs init-script wrappers in the user's pages.
- Patterns: `example.com` (with subdomains), `*.example.com`, exact `host:port` for localhost.

## 2. Content boundaries

- `--content-boundaries` (agent flag, or a user setting "always"): output that comes from the page
  (`snapshot`, `get text/html/value/attr`, `read`, `console`, `errors`, `eval` results, dialog
  messages, network bodies) is wrapped in markers with a per-response nonce, for example:

  ```
  <<<page-content nonce=7f3a… url=https://example.com>>>
  …
  <<<end page-content nonce=7f3a…>>>
  ```

  Copy upstream's exact marker format if agents are trained on it (check the upstream source;
  the skill docs don't show it).
- The nonce stops a page from closing the block early: a page can print the marker text, but not
  the nonce.
- These markers tell the agent where text came from. They are not a security boundary. Say so in
  the skill.

## 3. Output limit

- A global `--max-output <chars>` (and a user default) truncates stdout with
  `… [truncated N chars; narrow with -s/--filter]`. JSON gets `truncated: true`.
- It protects the agent's context from huge pages (long tables, infinite feeds) and works together
  with `read` and `snapshot -s`.

## 4. Action confirmation

- The user picks in the popup which categories need a click on **Allow** at the time they run:
  - `eval` (arbitrary JS in a logged-in page)
  - `upload` (local files leave the machine)
  - `navigate-new-site` (agent tab goes to a site not yet visited in this session)
- It reuses the consent approval flow (popup card, or a small window if Chrome isn't focused, with
  a 120 s timeout). The card shows the session, command and target, with the arguments **redacted**
  as in the activity log.
- Agent flag `--confirm-actions eval,upload` can add categories, never remove them.
- Builds on the approval rules in [security.md](../architecture/security.md) (approvals are never
  restored after a worker restart; closing the tab fails the waiter).

## Impact

- `dispatch.ts` / `command.ts` (policy check before `run`, wrapping, truncation), `tabs.ts` (approval
  flow reuse), `cdp.ts` (Fetch for document navigations), popup UI + `ui.md`, `security.md`
  (new rules), `cli/skills/core/` (what the agent sees when blocked).
- Settings live in `chrome.storage.local` next to the pairing settings. That is a new persisted
  key, so runtime.md must be updated.
- Risk: High (consent / security surface). It needs your sign-off and a manual test of block, allow
  and deny.

## Suggested order

Output limit → content boundaries → allowed domains (commands layer) → action confirmation →
allowed domains (Fetch layer).

## Open questions

- Should a user-set allowlist also restrict *shared* tabs that the agent navigates by clicking?
- Default state of content boundaries: off (upstream default) or on for everything except
  `get title/url`?
