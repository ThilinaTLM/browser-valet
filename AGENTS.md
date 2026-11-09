# AGENTS.md

- Read `docs/architecture/README.md` (principles, change risk) and `docs/architecture/glossary.md` before design changes, then the page for the area you touch.
- Take extra care with High-risk areas: auth handshake, Origin rule and the manifest `key`; tab consent and grants; the managed extension folder and persisted config files.
- The wire protocol contract is `docs/architecture/protocol.md`. Change it together with the CLI, the proxy and the extension.
- New ideas and unbuilt work go in `docs/proposals/`. After implementing a proposal, decommission it into architecture.
- Update affected architecture pages and `cli/skills/` in the same change when behaviour or rules change.
