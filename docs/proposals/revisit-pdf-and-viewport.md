# Revisit: `pdf` and `set viewport` / `set media` on agent tabs

**Status:** Draft · **Area:** automation

## Problem

The settled directions exclude "emulation" and "video/trace/pdf", because they "would modify the
real profile or aren't needed". Two of these don't touch the profile and come up in real tasks:

- `pdf <path>`: save a page (invoice, receipt, statement behind a login) as PDF. The logged-in
  browser is exactly where those pages are.
- `set viewport <w> <h> [scale]` and `set media dark|light [reduced-motion]`: check responsive
  layouts or dark mode of the user's app while logged in.

Accepting this proposal changes a settled direction. It needs your sign-off, and README.md
(Settled directions) and the proposals README (Not planned) must be updated.

## Why these are profile-safe

- `Page.printToPDF` only reads the page.
- `Emulation.setDeviceMetricsOverride` / `Emulation.setEmulatedMedia` apply to the debugger session
  of one tab and end when the debugger detaches. They are not written to the profile.

## Design

- `pdf <path> [--landscape] [--background]`: `Page.printToPDF`, file returned in `res.files`.
  Allowed on agent and shared tabs (read-only).
- `set viewport` / `set media`: **agent tabs only**. On a shared tab, refuse with a clear error,
  because the user would see their own page resize or change theme. Cleared by `set viewport reset`,
  on `close`, and on detach.
- Keep out: `set device` (user agent and touch emulation affect what servers see in a logged-in
  account), `set geo`, `set offline`, `set headers`, `set credentials`.

## Risks / to verify

- **Spike needed:** check that `Page.printToPDF` works in a headed (non-headless) Chrome through
  `chrome.debugger`. Historically it was headless-only.
- If the user switches to an agent tab, they see the emulated viewport. That's acceptable for agent
  tabs, but mention it in the skill.

## Open questions

- Should `set viewport` stay active across navigations in the same tab? (Emulation persists while
  attached, so yes.)
