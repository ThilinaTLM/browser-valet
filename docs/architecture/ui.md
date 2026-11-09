# Popup UI

The toolbar popup (`extension/static/popup.html`, `popup.css`, `extension/src/popup/popup.ts`)
and the toolbar badge (`extension/src/background/tabs.ts`). `popup.css` is authoritative for
token values. Nothing tests the styling.

## Rules

- **Default:** use the Nerve theme tokens in `popup.css`, not raw colours or sizes. The tokens are ported from Nerve's ui-kit (`packages/ui-kit/src/styles/theme.css`). A theme supplies only colour inputs, and everything else is derived. *Why:* the popup should match Nerve, and light and dark follow from one set of inputs.
- **MUST** make no network requests from the popup. Fonts (Outfit 400/500/600, Iosevka 400/500) are copied from `@fontsource` into `dist/fonts` by `build.mjs`. *Why:* this is an extension running in the user's real browser. Offline use and privacy matter.
- **MUST** keep logic out of the popup. It sends messages to the worker and renders state. *Why:* the popup is often closed, and consent waiters live in the worker.
- **Default:** light or dark follows `prefers-color-scheme`. There is no in-popup theme switch.

## Tokens

| Group | Tokens |
|---|---|
| Colour inputs (per theme) | `--background`, `--foreground`, `--primary` (ember), `--success`, `--warning`, `--info`, `--destructive`, `--destructive-solid`, `--on-solid` |
| Derived | `--card`, `--well*`, `--muted`, `--muted-foreground`, `--border`, `--border-subtle`, `--input`, `--ring`, `--focus`, `--hover`, `*-subtle`, `*-strong`, `--primary-foreground` |
| Derivation knobs | `--step-card`, `--step-well`, `--mix-*` |
| Geometry / type | `--radius`, `--radius-md`, `--spacing-control(-sm)`, `--text-ui`, `--text-caption`, `--text-title` (+ line heights), `--font-sans`, `--font-mono` |
| Elevation | `--elevation-strength`, `--elevation-hsl`, `--shadow-sm` |

To add a colour, add an input for both themes, or derive one from existing inputs in `:root`.

## Design

- Sections: connection status and the on/off switch; pairing (only for manual pairing); permission requests (Allow/Deny); This tab (share/stop); Agent tabs (Stop / Stop all); Recent activity.
- When a permission request arrives, the worker opens the popup, or a small window if Chrome isn't focused.
- Badge: `AI` on controlled tabs and `!` while an approval is pending. Its colours are hex literals in `tabs.ts` (`chrome.action` takes no CSS variables). Keep them close to `--primary` / `--warning`.

## Change risk

Low. Layout and styling are local. Changes to the approval card or the This tab actions touch consent, so check [security.md](security.md).
