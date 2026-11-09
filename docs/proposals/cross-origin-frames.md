# Cross-origin iframes and the `frame` command

**Status:** Draft · **Area:** automation

## Problem

Snapshots inline only same-process iframes. Cross-origin (out-of-process, OOPIF) iframes are skipped
(`iframeTree` in `snapshot.ts` catches and returns `undefined`). In a real, logged-in browser these
are common: payment fields (Stripe, Adyen), SSO and consent widgets, embedded editors. Agents can't
see or act on them. agent-browser inlines iframe content with working refs, and has
`frame <sel|@ref|main>` to scope later commands to one frame. Verified on 0.41.2 with a cross-site
iframe ([observed-output.md](agent-browser-parity/observed-output.md)):

```
- Iframe "payment-frame" [ref=e42]
  - textbox "Card number" [ref=e46]
  - button "Pay" [ref=e47]
```

## Current state

- `cdp.ts` attaches `chrome.debugger` to the tab (`{tabId}`) only. There are no child sessions.
- Refs store `{ backendNodeId, role, name }` per tab (`state.refs[tabId]`).
- Input is dispatched with `Input.dispatch*` on the tab, using viewport coordinates.

## Design

1. **Child sessions.** Chrome 125+ lets `chrome.debugger` address child targets with
   `{ tabId, sessionId }` (our floor is 127). After attaching, call
   `Target.setAutoAttach { autoAttach: true, flatten: true, waitForDebuggerOnStart: false }`. Track
   `Target.attachedToTarget` / `detachedFromTarget` for `type: "iframe"` only, and ignore workers.
   Enable `Runtime` (and `Page` if needed) on each child session.
2. **Snapshot.** When an `Iframe` AX node has no same-process frame, find the child session that owns
   its `frameId` and walk `Accessibility.getFullAXTree` there. Refs store the `sessionId`
   (`RefInfo` gains an optional `sessionId` field).
3. **Resolving and input.** `resolve` / `call` / `evaluate` go to the ref's session. Box
   coordinates from a child session are relative to the iframe, so add the iframe element's content
   box offset in the parent, repeating for nested frames. Then dispatch input on the top-level tab
   as today.
4. **`frame` command.** `frame <selector|@ref|name|url>` sets the session's current frame (a new field
   in the session state). `snapshot`, CSS selectors, `get`, `eval` and `wait --fn` are then scoped
   to that frame. `frame main` resets it. Navigation resets it to main.

## Consent

No change. Frames belong to the controlled tab. Child sessions must be created only for tabs that
pass `Ctx.tab()`, and must be dropped on revoke or detach.

## Risks

- Medium. `Target.setAutoAttach` also reports workers and service workers, so filter by type.
- State shape change (`RefInfo.sessionId`, session `frame`). They need defaults for the handoff
  (`restoreHandoff`). Child sessions don't survive a service-worker restart, so re-establish them
  lazily on the next command.
- Interaction with [debugger-attach-conflict.md](debugger-attach-conflict.md): child-session errors
  must not be mistaken for "already attached".

## Open questions

- Does `Accessibility.getFullAXTree` on a child session return the frame's tree directly, or do we
  need `frameId`? Verify in a spike.
- Should `frame` accept the upstream name/URL matching in its first version, or start with selector
  and ref only?
