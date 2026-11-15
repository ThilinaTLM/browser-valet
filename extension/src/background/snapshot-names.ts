// Pure helpers for snapshot node names and roles (no CDP), plus the page script that finds
// fallback names for nameless links and buttons.

/** Upper bound on nameless links/buttons looked up per snapshot. */
export const MAX_NAMELESS = 200;
/** Longest href shown as a `href=` attribute. */
export const MAX_HREF = 60;

/** `Hours Hours` → `Hours`: a name that is exactly one phrase repeated twice. */
export function dedupeName(name: string): string {
  const m = /^(.+) \1$/.exec(name);
  return m?.[1] ?? name;
}

/** Chrome-internal layout-table nodes: structure only, never shown (children are lifted). */
export const isLayoutRole = (role: string): boolean => role.startsWith('LayoutTable');

const ROLE_MAP: Record<string, string> = {
  // Chrome's date/time inputs are a group of spinbuttons.
  Date: 'group',
  DateTime: 'group',
  InputTime: 'group',
  InputDate: 'group',
  InputDateTimeLocal: 'group',
  InputMonth: 'group',
  InputWeek: 'group',
};

/** Standard ARIA-ish role for a Chrome-internal one (others unchanged). */
export const mapRole = (role: string): string => ROLE_MAP[role] ?? role;

/** Short form of an href for display: path+query when same-origin, else without the scheme. */
export function shortHref(href: string, base: string, max = MAX_HREF): string {
  let s = href;
  try {
    const u = new URL(href, base);
    const b = new URL(base);
    s = u.origin === b.origin ? u.pathname + u.search + u.hash : u.host + u.pathname + u.search;
  } catch {
    // keep the raw value
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** What the page script reports for one nameless link or button. */
export interface NamelessInfo {
  /** Name taken from an img alt, title, svg title or aria-describedby; empty when none. */
  name: string;
  /** Raw href attribute of a link; empty otherwise. */
  href: string;
}

/**
 * Page script, an expression evaluating to `{ els, info }`: links and buttons without any text,
 * in document order, and `[name, href]` for each.
 */
export function namelessScript(): string {
  return `(() => {
  const els = [], info = [];
  const sel = 'a[href], button, [role=link], [role=button]';
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  for (const el of document.querySelectorAll(sel)) {
    if (els.length >= ${String(MAX_NAMELESS)}) break;
    if (clean(el.textContent) || el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) continue;
    let name = '';
    const img = el.querySelector('img[alt], [role=img][aria-label]');
    if (img) name = clean(img.getAttribute('alt') || img.getAttribute('aria-label'));
    if (!name) { const t = el.querySelector('svg > title'); if (t) name = clean(t.textContent); }
    if (!name) name = clean(el.getAttribute('title'));
    if (!name) {
      const ids = (el.getAttribute('aria-describedby') || '').split(/\\s+/).filter(Boolean);
      name = clean(ids.map((i) => document.getElementById(i)?.textContent || '').join(' '));
    }
    els.push(el);
    info.push([name.slice(0, 150), el.tagName === 'A' || el.getAttribute('role') === 'link' ? (el.getAttribute('href') || '') : '']);
  }
  return { els, info };
})()`;
}
