// Cursor-interactive elements: things that act as buttons but have no interactive ARIA role
// (`<div onclick>`, `cursor: pointer` spans, `tabindex` containers). The page script finds them;
// the pure helpers here decide how a snapshot shows them. Mirrors agent-browser 0.41.2:
//   - generic "Save" [ref=e4] clickable [cursor:pointer, onclick]
//   - generic "Tab stop" [ref=e5] focusable [tabindex]

/** Upper bound on elements reported per snapshot (keeps big apps cheap). */
export const MAX_CLICKABLE = 500;

/** What the page script reports for one element. */
export interface ClickableInfo {
  /** `cursor:pointer`, `onclick`, `tabindex` (in that order). */
  reasons: string[];
  /** Trimmed text content, used as the name of an unnamed element in `-i` snapshots. */
  text: string;
}

/**
 * Suffix after the attributes. `clickable` when the element looks clickable (pointer cursor or
 * onclick); `focusable` when only `tabindex` makes it a candidate.
 */
export function clickableSuffix(reasons: readonly string[]): string {
  if (reasons.length === 0) return '';
  const word = reasons.some((r) => r !== 'tabindex') ? 'clickable' : 'focusable';
  return `${word} [${reasons.join(', ')}]`;
}

/**
 * Page script, an expression evaluating to `{ els, info }`: the candidate elements (in document
 * order) and `[reasons, text]` for each.
 *
 * - `cursor:pointer` counts only when the parent's cursor is not already pointer (a pointer is
 *   inherited, so every child of a clickable row would otherwise be listed). `onclick` and
 *   `tabindex >= 0` always count, and then also list an inherited pointer.
 * - Natively interactive elements (button, input, select, textarea, a[href]) are skipped, as are
 *   hidden and zero-size ones (agent-browser skips an empty `<div onclick>` too). Listeners added with `addEventListener` are invisible from the page.
 */
export function clickableScript(withText: boolean): string {
  return `(() => {
  const els = [], info = [];
  const skip = new Set(['HTML', 'HEAD', 'BODY', 'SCRIPT', 'STYLE', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION']);
  const all = document.getElementsByTagName('*');
  for (let i = 0; i < all.length && els.length < ${String(MAX_CLICKABLE)}; i++) {
    const el = all[i];
    if (skip.has(el.tagName) || (el.tagName === 'A' && el.hasAttribute('href'))) continue;
    const ptr = getComputedStyle(el).cursor === 'pointer';
    const inherited = ptr && el.parentElement !== null && getComputedStyle(el.parentElement).cursor === 'pointer';
    const onclick = el.hasAttribute('onclick') || typeof el.onclick === 'function';
    const tab = el.hasAttribute('tabindex') && el.tabIndex >= 0;
    if (!((ptr && !inherited) || onclick || tab)) continue;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) continue;
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const reasons = [];
    if (ptr) reasons.push('cursor:pointer');
    if (onclick) reasons.push('onclick');
    if (tab) reasons.push('tabindex');
    els.push(el);
    info.push([reasons, ${withText ? "(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300)" : "''"}]);
  }
  return { els, info };
})()`;
}
