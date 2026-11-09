# Development

Build, embedding, CI and testing. Everyday commands are in the root [README](../../README.md#development).

## Rules

- **MUST** build the extension before the CLI for any release build. `cli/build.rs` embeds `extension/dist` (excluding `.map` files) and `cli/skills/` into the binary. *Why:* "one binary" is the install story, and `setup` and updates write the embedded copy.
- **MUST** keep `cli/Cargo.toml`, `extension/package.json` and `extension/static/manifest.json` at the same version. `build.rs` fails when the dist manifest's version differs from the crate's. *Why:* see the single-version principle in [README.md](README.md).
- **Default:** CI gates are `cargo fmt --check`, `cargo clippy --all-targets -D warnings` and `cargo test` on Linux, macOS and Windows, plus `pnpm check` (tsc, eslint, prettier), `pnpm test` (unit) and `pnpm build` for the extension, and `pnpm test:e2e` on Linux. Run the same locally before pushing.
- **Default:** never put `pairing.json` or other secrets in `extension/dist`. `build.mjs` deletes it. Keep `extension/key.pem` gitignored.

## Design

- Without `extension/dist`, the CLI still builds (with a cargo warning). `EXT_VERSION` is `None`, and `bctl setup` reports that this build has no extension. Such a binary never triggers updates.
- CI builds the extension once, shares `dist` as an artifact with the three CLI jobs, and uploads `bctl` per OS. There is no release or signing pipeline.
- Developing the extension: load `extension/dist` unpacked, run `bctl pair <code>`, and use `pnpm watch` plus a manual reload. Remove the managed copy first: Chrome rejects two unpacked extensions with the same ID.
- Toolchains: Rust stable (edition 2021), Node 22 with pnpm (`packageManager` in `package.json`), TypeScript strict via `tsc --noEmit`, esbuild bundle (ESM).

## Testing

- `cli/tests/relay.rs` runs real proxies against fake CLI and extension clients. It covers the handshake, the Origin/role rules, relaying, cancel (CLI disconnect, failed write, no double cancel), idle exit, shutdown (including failing in-flight requests), refusing to restart a busy proxy of another version, managed updates (stale-file removal, 0600 `pairing.json`), skills, `setup` idempotence and `bctl doctor` (each check, `--json`, `--quick`, `--fix` for permissions and the managed folder, a squatter on the port). Tests set `BCTL_CONFIG_DIR`, `BCTL_EXT_WAIT_MS` and a small idle timeout.
- Not covered: the successful version-mismatch restart and proxy spawning (including Windows flags).

### Extension tests (`extension/test/`)

- **Unit** (`pnpm test`, Vitest, `test/unit/`): pure and state logic with a mocked `chrome.*`: `parseArgs`, help generation, the activity log line (`describe()` redaction, as it behaves today), `loadState` / handoff restore and merge, pairing, tab ids, label rules. `test/helpers/chrome-mock.ts` is the reusable mock (`installChromeMock()`: `storage.session`/`local`, events, `tabs`, `action`, `debugger` stubs). Install it before importing the worker modules, because they touch `chrome` at import time, and call `vi.resetModules()` in `beforeEach` for fresh module state.
- **E2E** (`pnpm test:e2e`, `test/e2e/`): real Chrome for Testing (headless) with the real extension, driven through real `bctl` subprocesses. `global-setup.ts` runs once. It builds the extension and `cargo build`s the CLI (skip with `E2E_SKIP_BUILD=1`, or point `BCTL_BIN` at a binary) and runs `bctl setup --no-open --no-wait` into a temp `BCTL_CONFIG_DIR` with a free non-default `BCTL_PORT`. It then starts a static server for `test/e2e/fixtures/`, launches Chrome with a temp profile and `--load-extension=<managed folder>`, and waits until `bctl status` sees the extension. Teardown runs `bctl stop` and deletes the temp dirs. Nothing touches the real bctl config, proxy, port 47823 or browser profile.
- Add an E2E file as `test/e2e/<name>.test.ts` using `harness.ts`. `bctl(...args)` and `bctlJson(...)` run the CLI, `fixture('/x.html')` gives a fixture URL, `openUserTab(url)` opens a tab as the user would, `approveNextConsent('allow' | 'deny')` opens the popup (`popup.html?window=1`) and clicks the real Allow or Deny button, and `stopTabInPopup(tid)` clicks Stop. Start the consenting command first, then approve, then await the command. There is no test-only consent bypass in production code.
- Chrome comes from `CHROME_PATH`, else the newest Chrome for Testing in the puppeteer cache (`npx @puppeteer/browsers install chrome@stable`). Branded Chrome 137+ ignores `--load-extension`, so it cannot be used. `E2E_HEADFUL=1` shows the window, and `CI` adds `--no-sandbox`. Headless Chrome loads extensions, so CI needs no xvfb.
- CI: the `extension` job also runs the unit tests, and the Linux-only `e2e` job runs the E2E suite. Run `pnpm check && pnpm test && pnpm test:e2e` before touching consent, tabs, state or dispatch.
- Not covered: self-update and handoff in a real browser, service-worker restarts, and CDP behaviour beyond the smoke commands. Add a unit or E2E test with each change to those areas.

## Change risk

| Area | Risk | Required care |
|---|---|---|
| `build.rs` embedding and version assert | Medium | a bad embed ships a broken managed folder to every user on update |
| CI workflow | Low | keep all three OS jobs and the E2E job |
