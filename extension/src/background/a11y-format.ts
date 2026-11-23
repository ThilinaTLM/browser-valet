// Shaping and printing of axe-core results for `a11y`. Pure (no chrome.* access) so the rules can
// be unit-tested. See automation.md ("a11y").

/** One selector path entry: a CSS selector, or an array of them across shadow DOM boundaries. */
export type TargetPart = string | string[];

export interface AxeNodeRaw {
  html?: string;
  target?: TargetPart[];
  failureSummary?: string;
  impact?: string | null;
}

export interface AxeRuleRaw {
  id: string;
  impact?: string | null;
  help?: string;
  helpUrl?: string;
  tags?: string[];
  nodes?: AxeNodeRaw[];
}

export interface AxeReportRaw {
  violations?: AxeRuleRaw[];
  incomplete?: AxeRuleRaw[];
  passes?: AxeRuleRaw[];
  inapplicable?: AxeRuleRaw[];
}

export interface A11yNode {
  target: TargetPart[];
  html: string;
  failureSummary: string;
  /** Ref of the element in the tab's last snapshot (bvl-only). */
  ref?: string;
}

export interface A11yRule {
  id: string;
  impact: string;
  help: string;
  helpUrl: string;
  tags: string[];
  nodeCount: number;
  nodes: A11yNode[];
}

export interface A11yData {
  axeVersion: string;
  url: string;
  counts: { violations: number; incomplete: number; passes: number; inapplicable: number };
  violations: A11yRule[];
  incomplete: A11yRule[];
}

/** Nodes kept per rule in `--json` (as upstream). */
export const MAX_JSON_NODES = 10;
/** Example targets printed per rule in the text output. */
export const MAX_TEXT_NODES = 5;
/** Characters of a node's HTML kept (as upstream). */
export const MAX_HTML = 300;

const IMPACTS = ['critical', 'serious', 'moderate', 'minor'];
const rank = (impact: string | null | undefined): number => {
  const i = impact ? IMPACTS.indexOf(impact) : -1;
  return i < 0 ? IMPACTS.length : i;
};

/** The rule's impact; axe leaves it empty on some `incomplete` rules, so use the worst node's. */
function ruleImpact(r: AxeRuleRaw): string {
  if (r.impact) return r.impact;
  let best: string | null = null;
  for (const n of r.nodes ?? []) {
    if (n.impact && rank(n.impact) < rank(best)) best = n.impact;
  }
  return best ?? 'unknown';
}

/** The rules in axe's order (as upstream's `--json`). */
export function shapeRules(rules: AxeRuleRaw[] | undefined): A11yRule[] {
  return (rules ?? []).map((r): A11yRule => {
    const nodes = r.nodes ?? [];
    return {
      id: r.id,
      impact: ruleImpact(r),
      help: r.help ?? '',
      helpUrl: r.helpUrl ?? '',
      tags: r.tags ?? [],
      nodeCount: nodes.length,
      nodes: nodes.slice(0, MAX_JSON_NODES).map((n) => ({
        target: n.target ?? [],
        html: (n.html ?? '').slice(0, MAX_HTML),
        failureSummary: n.failureSummary ?? '',
      })),
    };
  });
}

/** Most severe first, then by rule id (the text output). */
const bySeverity = (rules: A11yRule[]): A11yRule[] =>
  [...rules].sort((a, b) => rank(a.impact) - rank(b.impact) || a.id.localeCompare(b.id));

/**
 * A target as one line. Entries are separated by ` >> ` where the path crosses an iframe
 * boundary (axe lists the iframe's selector first) and by ` >>> ` inside shadow DOM.
 */
export function targetText(target: TargetPart[]): string {
  return target.map((p) => (Array.isArray(p) ? p.join(' >>> ') : p)).join(' >> ');
}

function ruleText(r: A11yRule): string[] {
  const n = r.nodeCount;
  const lines = [
    `[${r.impact}] ${r.id}: ${r.help} (${String(n)} ${n === 1 ? 'node' : 'nodes'})`,
    `  ${r.helpUrl}`,
  ];
  for (const node of r.nodes.slice(0, MAX_TEXT_NODES)) {
    lines.push(`  - ${targetText(node.target)}${node.ref ? ` @${node.ref}` : ''}`);
  }
  if (n > MAX_TEXT_NODES) lines.push(`  … ${String(n - MAX_TEXT_NODES)} more (use --json)`);
  return lines;
}

/** Text output: header, violations by impact, then the rules that need a manual review. */
export function formatText(d: A11yData): string {
  const out = [
    `url: ${d.url}`,
    `axe-core: ${d.axeVersion}  violations: ${String(d.counts.violations)}  incomplete: ${String(d.counts.incomplete)}  passes: ${String(d.counts.passes)}`,
  ];
  if (d.violations.length) {
    out.push('');
    for (const r of bySeverity(d.violations)) out.push(...ruleText(r));
  }
  if (d.incomplete.length) {
    out.push('', 'incomplete (needs manual review):');
    for (const r of bySeverity(d.incomplete)) out.push(...ruleText(r));
  }
  return out.join('\n');
}

/** Split a comma-separated `--tags` value. */
export function parseTags(v: string): string[] {
  return v
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}
