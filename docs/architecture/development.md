# Development

Build, embedding, CI and testing. Everyday commands are in the root [README](../../README.md#development).

## Rules

- **MUST** build the extension before the CLI for any release build. `cli/build.rs` embeds `extension/dist` (excluding `.map` files) and `cli/skills/` into the binary. *Why:* "one binary" is the install story, and `setup` and updates write the embedded copy.
- **MUST** keep `cli/Cargo.toml`, `extension/package.json` and `extension/static/manifest.json` at the same version. `build.rs` fails when the dist manifest's version differs from the crate's. *Why:* see the single-version principle in [README.md](README.md).
- **Default:** CI gates are `cargo fmt --check`, `cargo clippy --all-targets -D warnings` and `cargo test` on Linux, macOS and Windows, plus `pnpm check` (tsc, eslint, prettier), `pnpm test` (unit) and `pnpm build` for the extension, and `pnpm test:e2e` on Linux. CI runs the parts of `pnpm check` as separate parallel steps; locally, `pnpm check` is still the command. Run the same locally before pushing.
- **Default:** never put `pairing.json` or other secrets in `extension/dist`. `build.mjs` deletes it. Keep `extension/key.pem` gitignored.

## Design

- Without `extension/dist`, the CLI still builds (with a cargo warning). `EXT_VERSION` is `None`, and `bvl setup` reports that this build has no extension. Such a binary never triggers updates.
- CI (`.github/workflows/ci.yml`) runs on pushes to `main` and on pull requests, skips changes that only touch `docs/**`, `README.md`, the root `SKILL.md`, `LICENSE` or `NOTICE`, and cancels a run when a newer commit lands on the same ref (never on tags). The `Extension` job runs typecheck, lint, format, unit tests and build as `parallel` steps and shares `dist` as the `extension-dist` artifact with the three `CLI` jobs, which only check (fmt, clippy, test with `--locked`) and upload no binaries. `E2E` starts at once, independent of `Extension`. The Rust cache is saved only on `main`. Every job has a `timeout-minutes`. Dependabot (`.github/dependabot.yml`) bumps the actions weekly in one grouped PR.
- Releasing: bump the three versions, commit, then push a `vX.Y.Z` tag. `.github/workflows/release.yml` runs `verify-version → ci → build → publish`: it checks that the tag matches all three versions (a mismatch stops before CI runs), reruns the whole CI workflow (`workflow_call`), builds `bvl` with the CI's `extension-dist` embedded for `x86_64`/`aarch64` Linux (static musl), `x86_64`/`aarch64` macOS and `x86_64` Windows, and creates a GitHub release with `bvl-<target>.tar.gz` (`.zip` on Windows), `SHA256SUMS` and generated notes. Tags with a `-` (e.g. `v0.2.0-rc.1`) become pre-releases. Asset names carry no version so `releases/latest/download/…` links stay stable. Binaries are not code-signed or notarized.
- Developing the extension: load `extension/dist` unpacked, run `bvl pair <code>`, and use `pnpm watch` plus a manual reload. Remove the managed copy first: Chrome rejects two unpacked extensions with the same ID.
- Toolchains: Rust stable (edition 2021), Node 22 with pnpm (`packageManager` in `package.json`), TypeScript strict via `tsc --noEmit`, esbuild bundle (ESM).

## Testing

- `cli/tests/relay.rs` runs real proxies against fake CLI and extension clients. It covers the handshake, the Origin/role rules, relaying, cancel (CLI disconnect, failed write, no double cancel), idle exit, shutdown (including failing in-flight requests), refusing to restart a busy proxy of another version, managed updates (stale-file removal, 0600 `pairing.json`), skills, `setup` idempotence and `bvl doctor` (each check, `--json`, `--quick`, `--fix` for permissions and the managed folder, a squatter on the port), and the split between config and data dirs. Tests set `BVL_CONFIG_DIR` (which data and logs fall back to unless `BVL_DATA_DIR` is set), `BVL_EXT_WAIT_MS` and a small idle timeout.
- Not covered: the successful version-mismatch restart and proxy spawning (including Windows flags).

### Extension tests (`extension/test/`)

- **Unit** (`pnpm test`, Vitest, `test/unit/`): pure and state logic with a mocked `chrome.*`: `parseArgs`, help generation, the activity log line (`describe()` redaction, as it behaves today), `loadState` / handoff restore and merge, pairing, tab ids, label rules. `test/helpers/chrome-mock.ts` is the reusable mock (`installChromeMock()`: `storage.session`/`local`, events, `tabs`, `action`, `debugger` stubs). Install it before importing the worker modules, because they touch `chrome` at import time, and call `vi.resetModules()` in `beforeEach` for fresh module state.
- **E2E** (`pnpm test:e2e`, `test/e2e/`): real Chrome for Testing (headless) with the real extension, driven through real `bvl` subprocesses. `global-setup.ts` runs once. It builds the extension and `cargo build`s the CLI (skip with `E2E_SKIP_BUILD=1`, or point `BVL_BIN` at a binary) and runs `bvl setup --no-open --no-wait` into a temp `BVL_CONFIG_DIR` and `BVL_DATA_DIR` with a free non-default `BVL_PORT`. It then starts a static server for `test/e2e/fixtures/`, launches Chrome with a temp profile and `--load-extension=<managed folder>`, and waits until `bvl status` sees the extension. Teardown runs `bvl stop` and deletes the temp dirs. Nothing touches the real bvl config or data dirs, proxy, port 47823 or browser profile.
- Add an E2E file as `test/e2e/<name>.test.ts` using `harness.ts`. `bvl(...args)` and `bvlJson(...)` run the CLI, `fixture('/x.html')` gives a fixture URL, `openUserTab(url)` opens a tab as the user would, `approveNextConsent('allow' | 'deny')` opens the popup (`popup.html?window=1`) and clicks the real Allow or Deny button, and `stopTabInPopup(tid)` clicks Stop. Start the consenting command first, then approve, then await the command. There is no test-only consent bypass in production code.
- Chrome comes from `CHROME_PATH`, else the newest Chrome for Testing in the puppeteer cache (`npx @puppeteer/browsers install chrome@stable`). Branded Chrome 137+ ignores `--load-extension`, so it cannot be used. `E2E_HEADFUL=1` shows the window, and `CI` adds `--no-sandbox`. Headless Chrome loads extensions, so CI needs no xvfb.
- CI: the `extension` job also runs the unit tests, and the Linux-only `e2e` job runs the E2E suite. It installs Chrome for Testing in parallel with building the extension and `bvl`, then runs the suite with `E2E_SKIP_BUILD=1`. Run `pnpm check && pnpm test && pnpm test:e2e` before touching consent, tabs, state or dispatch.
- Not covered: self-update and handoff in a real browser, service-worker restarts, and CDP behaviour beyond the smoke commands. Add a unit or E2E test with each change to those areas.

## Change risk

| Area | Risk | Required care |
|---|---|---|
| `build.rs` embedding and version assert | Medium | a bad embed ships a broken managed folder to every user on update |
| CI workflow | Low | keep all three OS jobs and the E2E job |
| Release workflow | Medium | keep the CI gate, the version check and the embedded extension; asset names are used by the README install commands |
