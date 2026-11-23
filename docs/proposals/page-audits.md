# Page audits: `a11y` and `vitals`

**Status:** Draft · **Labels:** feature, automation

## Problem

Agents testing web apps in the user's browser (dev servers, staging behind SSO) want quick
accessibility and performance checks. agent-browser has `a11y` (axe-core audit; `--tags`,
`--selector`, `--json`) and `vitals` (built: see [automation.md](../architecture/automation.md)).

## Design

### `a11y [url] [--tags wcag2a,wcag2aa] [--selector <css>]`

- Bundle axe-core (MPL-2.0) in the extension and inject it with `Runtime.evaluate` into the page.
  CDP evaluation is not subject to the page's CSP.
- Output: violations grouped by rule, with impact, count and up to N example targets. If possible,
  map the targets to refs from the last snapshot.
- Read-only. Note that axe-core adds a global (`window.axe`) to the page. Remove it afterwards.
- Bundle size (≈ 500 KB) is the main cost.

## Priority

Low. Useful for web developers, but not needed for general browsing.

## Open questions

- Is the bundle size acceptable, or should axe-core be loaded only on demand (it can't be fetched
  remotely in MV3; it has to be bundled)?
