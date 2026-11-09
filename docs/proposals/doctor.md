# `bctl doctor`

**Status:** Draft · **Area:** runtime

## Problem

When `bctl` fails ("not connected", "server authentication failed", version mismatch, a stale
managed folder), the agent and the user have to guess which part is broken. `bctl status` shows only
a summary. agent-browser has `doctor` (with `--json`, `--quick`, `--fix`), and agents are trained to
run it first when something fails.

## Design

A CLI-local command (add it to the CLI-local list in [protocol.md](../architecture/protocol.md)). It
runs checks in order and prints ✓/✗ with a one-line fix for each:

1. Config: `config.json` exists, has a secret, and its permissions are 0600 on Unix.
2. Managed folder: present, `pairing.json` matches the config, the embedded extension version
   matches the binary.
3. Proxy: is the port reachable; does the handshake succeed (a squatter shows up as auth failure);
   proxy version.
4. Extension: connected; extension version equals the CLI version (principle 4); browser name and
   version ≥ 127.
5. Round trip: a no-op request (e.g. `help`) and its latency.

`--json` gives structured results. `--fix` does only safe repairs: restart the proxy (`stop`, then
auto-start) and rewrite the managed folder. It never re-pairs or touches browser state without the
user.

## Impact

- `cli/src/main.rs` (+ tests). If the extension needs to report its version, the reply comes from a
  normal `req`. Prefer reusing an existing command's output over a new message type.
- Update the skill: "if a command fails unexpectedly, run `bctl doctor`".

## Open questions

- Merge into `bctl status --verbose` instead of adding a new name? (Recommendation: add `doctor`,
  because agents already know the name from agent-browser.)
