# Proposals

Ideas, planned work, debt fixes and redesigns that are not built yet. Nothing here is a commitment.
Current behaviour lives in [architecture](../architecture/README.md).

## Lifecycle

Draft → Accepted (add `## Decision` with what and why) → Implemented (decommission: move durable
rules into architecture, delete the proposal) | Rejected (delete, or add one line under Not planned).

## Layout

- Simple: `proposals/<kebab-feature>.md`.
- Complex (multi-screen UI, several alternatives, deep sub-designs): a folder `proposals/<feature>/`
  with `README.md` (the decision record, readable without HTML) and optional `<topic>.md` notes,
  `<screen>.html` wireframes and `assets/`.
- Wireframes are self-contained HTML (inline CSS/JS, no network, synthetic data). Mirror the
  popup's tokens ([ui.md](../architecture/ui.md)) as CSS variables. They are never shipped.

## Template

```markdown
# Title

**Status:** Draft · **Area:** <area>

## Problem

## Current state

## Options

## Recommendation

## Open questions
```

## Index

| Proposal | Area | Status |
|---|---|---|
| [activity-log-redaction.md](activity-log-redaction.md) | security | Draft |
| [stale-approvals.md](stale-approvals.md) | security | Draft |
| [proxy-request-lifecycle.md](proxy-request-lifecycle.md) | runtime | Draft |
| [debugger-attach-conflict.md](debugger-attach-conflict.md) | automation | Draft |
| [extension-tests.md](extension-tests.md) | development | Draft |

## Roadmap

### Debt

- [ ] Redact all free-text arguments in the activity log: [activity-log-redaction.md](activity-log-redaction.md)
- [ ] Clear orphaned approvals after a service-worker restart: [stale-approvals.md](stale-approvals.md)
- [ ] Close the proxy request-lifecycle gaps: [proxy-request-lifecycle.md](proxy-request-lifecycle.md)
- [ ] Detect DevTools holding the debugger: [debugger-attach-conflict.md](debugger-attach-conflict.md)
- [ ] Add extension tests: [extension-tests.md](extension-tests.md)

## Not planned

- Cookies/storage/state commands, network interception, emulation, video/trace/pdf: they would modify the real profile or aren't needed.
- Firefox: there is no `chrome.debugger`.
- Off-store `.crx` install: Chrome rejects it.
