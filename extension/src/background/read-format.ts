// Pure helpers for `read`: outline, section filter and truncation over extracted markdown.
// Output formats mirror agent-browser 0.41.2 (docs/architecture/automation.md).

interface Section {
  level: number;
  title: string;
  /** Index of the first line (the heading) and one past the last line of the section. */
  start: number;
  end: number;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

function headings(lines: string[]): { level: number; title: string; line: number }[] {
  const out: { level: number; title: string; line: number }[] = [];
  let fence: string | undefined;
  lines.forEach((l, line) => {
    const f = /^\s*(```+|~~~+)/.exec(l)?.[1];
    if (f) {
      if (!fence) fence = f;
      else if (f.startsWith(fence[0] ?? '') && f.length >= fence.length) fence = undefined;
      return;
    }
    if (fence) return;
    const m = HEADING.exec(l);
    if (m) out.push({ level: (m[1] ?? '#').length, title: m[2] ?? '', line });
  });
  return out;
}

/** A section runs from its heading to the next heading of the same or a higher level. */
function sections(lines: string[]): Section[] {
  const hs = headings(lines);
  return hs.map((h, i) => {
    const next = hs.slice(i + 1).find((n) => n.level <= h.level);
    return { level: h.level, title: h.title, start: h.line, end: next?.line ?? lines.length };
  });
}

export function outline(markdown: string, source: string): string {
  const hs = headings(markdown.split('\n'));
  // Indent by nesting depth, not by raw level, so a page starting at h2 is not indented.
  const stack: number[] = [];
  const items = hs.map((h) => {
    while (stack.length && (stack[stack.length - 1] ?? 0) >= h.level) stack.pop();
    stack.push(h.level);
    return `${'  '.repeat(stack.length - 1)}- ${h.title}`;
  });
  return ['# Outline', '', `Source: ${source}`, '', ...items].join('\n').trimEnd();
}

/**
 * Sections whose heading or own text (up to the next heading) contains `text`, case-insensitive.
 * A match returns the whole section with its subsections; nested matches are not repeated.
 */
export function filterSections(markdown: string, text: string): string {
  const lines = markdown.split('\n');
  const needle = text.toLowerCase();
  const all = sections(lines);
  const taken: [number, number][] = [];
  all.forEach((s, i) => {
    if (taken.some(([a, b]) => s.start >= a && s.end <= b)) return;
    const ownEnd = all[i + 1]?.start ?? lines.length;
    if (lines.slice(s.start, ownEnd).join('\n').toLowerCase().includes(needle)) {
      taken.push([s.start, s.end]);
    }
  });
  if (!taken.length) return 'No matching page sections';
  return taken.map(([a, b]) => lines.slice(a, b).join('\n').trim()).join('\n\n');
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated: showing ${max} of ${text.length} chars. Use --max-output to adjust]`;
}
