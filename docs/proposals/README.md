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
| [agent-browser-parity/](agent-browser-parity/README.md) | automation, security | Draft (umbrella) |
| [page-audits.md](page-audits.md) | automation | Draft |

## Roadmap

### agent-browser parity

Overview and priorities: [agent-browser-parity/](agent-browser-parity/README.md).

- [ ] `a11y` / `vitals`: [page-audits.md](page-audits.md)

## Not planned

- `wait --download [path]` (agent-browser's wait for a download): skipped by decision. It needs the manifest `downloads` permission, which widens what the extension can see, and downloads land in the user's real Downloads folder. Revisit only with a security note.
- Cookies/storage/state commands, network interception (routing, mocking, blocking, header changes), video/trace, and `set device/geo/offline/headers/credentials`: they would modify the real profile, change what servers see, or aren't needed. Read-only `network requests` is built (see [security.md](../architecture/security.md)).
- Firefox: there is no `chrome.debugger`.
- Off-store `.crx` install: Chrome rejects it.
