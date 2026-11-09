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
| [debugger-attach-conflict.md](debugger-attach-conflict.md) | automation | Draft |
| [extension-tests.md](extension-tests.md) | development | Draft |
| [agent-browser-parity/](agent-browser-parity/README.md) | automation, security | Draft (umbrella) |
| [snapshot-delta.md](snapshot-delta.md) | automation | Draft |
| [snapshot-parity.md](snapshot-parity.md) | automation | Draft |
| [cli-output-conventions.md](cli-output-conventions.md) | automation | Draft |
| [small-parity-commands.md](small-parity-commands.md) | automation | Draft |
| [screenshot-improvements.md](screenshot-improvements.md) | automation | Draft |
| [cross-origin-frames.md](cross-origin-frames.md) | automation | Draft |
| [batch.md](batch.md) | automation | Draft |
| [read-command.md](read-command.md) | automation | Draft |
| [doctor.md](doctor.md) | runtime | Draft |
| [agent-guardrails.md](agent-guardrails.md) | security | Draft |
| [network-observe.md](network-observe.md) | automation, security | Draft |
| [revisit-pdf-and-viewport.md](revisit-pdf-and-viewport.md) | automation | Draft |
| [page-audits.md](page-audits.md) | automation | Draft |

## Roadmap

### Debt

- [ ] Redact all free-text arguments in the activity log: [activity-log-redaction.md](activity-log-redaction.md)
- [ ] Clear orphaned approvals after a service-worker restart: [stale-approvals.md](stale-approvals.md)
- [ ] Detect DevTools holding the debugger: [debugger-attach-conflict.md](debugger-attach-conflict.md)
- [ ] Add extension tests: [extension-tests.md](extension-tests.md)

### agent-browser parity

Overview and priorities: [agent-browser-parity/](agent-browser-parity/README.md).

- [ ] Stable, monotonic refs and `snapshot --delta`: [snapshot-delta.md](snapshot-delta.md)
- [ ] Output conventions (wait output, stderr warnings, JSON error codes, help): [cli-output-conventions.md](cli-output-conventions.md)
- [ ] Refs for clickable non-semantic elements: [snapshot-parity.md](snapshot-parity.md)
- [ ] `mouse`, `get styles`, `highlight`, `pushstate`, `session`, XPath: [small-parity-commands.md](small-parity-commands.md)
- [ ] `screenshot --annotate/--if-changed`: [screenshot-improvements.md](screenshot-improvements.md)
- [ ] Cross-origin iframes and `frame`: [cross-origin-frames.md](cross-origin-frames.md)
- [ ] `batch`: [batch.md](batch.md)
- [ ] `read`: [read-command.md](read-command.md)
- [ ] `bctl doctor`: [doctor.md](doctor.md)
- [ ] Guardrails (needs security sign-off): [agent-guardrails.md](agent-guardrails.md)
- [ ] Read-only network inspection (needs security sign-off): [network-observe.md](network-observe.md)
- [ ] Reconsider `pdf` and agent-tab viewport (changes a settled direction): [revisit-pdf-and-viewport.md](revisit-pdf-and-viewport.md)
- [ ] `a11y` / `vitals`: [page-audits.md](page-audits.md)

## Not planned

- Cookies/storage/state commands, network interception, emulation, video/trace/pdf: they would modify the real profile or aren't needed.
- Firefox: there is no `chrome.debugger`.
- Off-store `.crx` install: Chrome rejects it.
