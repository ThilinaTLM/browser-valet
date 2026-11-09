# Proxy request lifecycle gaps

**Status:** Draft · **Area:** runtime

## Problem

Three gaps in how the proxy ends requests:

- If writing to the CLI socket fails in `request`, the pending entry stays and the extension gets no `cancel`. The command keeps running.
- `shutdown` (sent by a newer CLI or by `pair`) exits without sending `res` to in-flight requests. Those CLIs see "connection closed by proxy".
- Two CLI binaries of different versions each restart the proxy when they see the other's version, which can loop.

## Current state

[runtime.md](../architecture/runtime.md) (debt marker). Code: `request` and `handle` in `cli/src/proxy.rs`, `connect` in `cli/src/main.rs`. None of these paths is tested.

## Options

1. Remove the pending entry and send `cancel` on every exit path of `request` (a drop guard). On shutdown, fail all pending requests with a `res` and send `cancel` to the extension.
2. Also, for version mismatch: don't restart a proxy that has pending requests. Report the conflict instead.

## Recommendation

Option 1, plus option 2's "don't restart while busy" check, with relay tests for each path.

## Open questions

- Is running two `bctl` versions at once a supported setup, or should it just error?
