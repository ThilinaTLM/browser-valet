# Stale approvals after service-worker restart

**Status:** Draft · **Area:** security

## Problem

Pending approvals are saved in `chrome.storage.session`, but the promise resolvers that answer the waiting CLI live only in memory. After a service-worker restart the card and the `!` badge remain, and Allow/Deny does nothing.

## Current state

[security.md](../architecture/security.md) (debt marker). Code: `requestControl`/`decide` in `extension/src/background/tabs.ts`, `loadState` in `state.ts`. A handoff already drops approvals.

## Options

1. Clear `approvals` in `loadState` whenever no waiter exists (same as handoff). The CLI request has already failed or will time out.
2. Keep the approvals and let Allow grant the tab anyway, so that the next `tab <tN>` succeeds without asking again.

## Recommendation

Option 1: simple, and it never grants without a live request.

## Open questions

- Should the CLI get a clearer error when the worker restarted mid-approval?
