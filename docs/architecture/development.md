# Development

Build, embedding, CI and testing. Everyday commands are in the root [README](../../README.md#development).

## Rules

- **MUST** build the extension before the CLI for any release build. `cli/build.rs` embeds `extension/dist` (excluding `.map` files) and `cli/skills/` into the binary. *Why:* "one binary" is the install story, and `setup` and updates write the embedded copy.
- **MUST** keep `cli/Cargo.toml`, `extension/package.json` and `extension/static/manifest.json` at the same version. `build.rs` fails when the dist manifest's version differs from the crate's. *Why:* see the single-version principle in [README.md](README.md).
- **Default:** CI gates are `cargo fmt --check`, `cargo clippy --all-targets -D warnings` and `cargo test` on Linux, macOS and Windows, plus `pnpm check` (tsc, eslint, prettier) and `pnpm build` for the extension. Run the same locally before pushing.
- **Default:** never put `pairing.json` or other secrets in `extension/dist`. `build.mjs` deletes it. Keep `extension/key.pem` gitignored.

## Design

- Without `extension/dist`, the CLI still builds (with a cargo warning). `EXT_VERSION` is `None`, and `bctl setup` reports that this build has no extension. Such a binary never triggers updates.
- CI builds the extension once, shares `dist` as an artifact with the three CLI jobs, and uploads `bctl` per OS. There is no release or signing pipeline.
- Developing the extension: load `extension/dist` unpacked, run `bctl pair <code>`, and use `pnpm watch` plus a manual reload. Remove the managed copy first: Chrome rejects two unpacked extensions with the same ID.
- Toolchains: Rust stable (edition 2021), Node 22 with pnpm (`packageManager` in `package.json`), TypeScript strict via `tsc --noEmit`, esbuild bundle (ESM).

## Testing

- `cli/tests/relay.rs` runs real proxies against fake CLI and extension clients. It covers the handshake, the Origin/role rules, relaying, cancel (CLI disconnect, failed write, no double cancel), idle exit, shutdown (including failing in-flight requests), refusing to restart a busy proxy of another version, managed updates (stale-file removal, 0600 `pairing.json`), skills, `setup` idempotence and `bctl doctor` (each check, `--json`, `--quick`, `--fix` for permissions and the managed folder, a squatter on the port). Tests set `BCTL_CONFIG_DIR`, `BCTL_EXT_WAIT_MS` and a small idle timeout.
- Not covered: the successful version-mismatch restart, proxy spawning (including Windows flags), and everything in the extension.

> **Known debt:** the extension has no automated tests. Consent, state and handoff, parsing and CDP behaviour are verified only by hand in Chrome. Do not extend this pattern. Fix: [proposal](../proposals/extension-tests.md).

## Change risk

| Area | Risk | Required care |
|---|---|---|
| `build.rs` embedding and version assert | Medium | a bad embed ships a broken managed folder to every user on update |
| CI workflow | Low | keep all three OS jobs |
