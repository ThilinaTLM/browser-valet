# Debugger attach conflict

**Status:** Draft · **Area:** automation

## Problem

`cdp.attach` ignores any error that matches `/already attached/i`, so that it can survive a service-worker restart where the extension is still attached. Chrome's "Another debugger is already attached" (DevTools open on that tab) matches too. The tab is then treated as attached and later commands fail with unclear errors.

## Current state

[automation.md](../architecture/automation.md) (debt marker). Code: `attach` in `extension/src/background/cdp.ts`. Not verified against a live Chrome with DevTools open.

## Options

1. Before attaching, check `chrome.debugger.getTargets()` for `attached` on the tab, and treat only the extension's own attachment as reusable.
2. On an "already attached" error, probe with a cheap `sendCommand`. If that fails, report "close DevTools on this tab".

## Recommendation

Option 2: it is robust without relying on how `getTargets` reports attachments.

## Open questions

- What exact error message does current Chrome return in each case?
