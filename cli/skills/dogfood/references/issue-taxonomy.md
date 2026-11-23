# Issue taxonomy

## Severity

| Severity | Meaning | Examples |
|---|---|---|
| critical | Blocks a core flow, loses or corrupts data, or exposes something private | Checkout fails; save drops edits; another user's data is visible |
| high | Major feature broken or unusable, no workaround | Search returns nothing; button does nothing; page stuck loading |
| medium | Feature works with a clear flaw or a workaround | Wrong validation message; filter resets on back; slow response |
| low | Cosmetic or minor polish | Misaligned icon; typo; inconsistent spacing |

## Categories

- **Functional**: wrong behaviour, dead controls, broken navigation or deep links, state lost on
  back/reload, validation gaps, duplicate submits, wrong data shown.
- **UX**: confusing flow, missing feedback (no spinner, no success/error message), unclear
  labels, destructive action without confirmation, dead ends, poor empty states.
- **Visual**: overlap, clipping, overflow, misalignment, broken images, wrong theme/dark mode,
  bad responsive layout, unreadable contrast, layout shift.
- **Console / network**: `bvl errors` entries, `bvl console` errors and warnings, 4xx/5xx or
  failed requests (`bvl network requests --status 400-599`), requests repeated in a loop,
  mixed content.
- **Accessibility**: unlabelled controls, missing alt text, focus order, keyboard traps,
  focus lost after a dialog, headings out of order, colour as the only signal.
- **Performance**: slow loads or interactions, long spinners, large or repeated requests
  (`network requests`), layout jumping while loading, unresponsive UI.
- **Content**: typos, placeholder text, stale or contradictory copy, untranslated strings.

## Exploration checklist

Per page:
- [ ] Loads without console errors, page errors or failed requests
- [ ] Screenshot looks right at desktop and mobile (`set viewport 390 844`) and in dark mode
- [ ] Every nav link, tab, menu and button responds (skip anything destructive or real-data)
- [ ] Loading, empty and error states exist and make sense
- [ ] Back, forward, reload and a pasted deep link keep the state
- [ ] Keyboard: Tab reaches every control in a sensible order; Esc closes dialogs
- [ ] Controls have names in `snapshot -i` (nameless ones are suspicious)

Per form:
- [ ] Client side only in a real account: required markers, labels, inline messages after `fill`
- [ ] Staging/demo only (or user agreed): submit empty or invalid; over-long and special-character input
- [ ] Required fields marked; errors say what to fix and appear near the field
- [ ] Focus moves to the first error; Enter submits where expected
- [ ] No submit in a real account unless the user asked for it

Per flow: complete it on a staging/demo instance if one exists, otherwise stop before the
final irreversible step and record that.
