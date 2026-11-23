import { describe, expect, it } from 'vitest';
import {
  type A11yData,
  formatText,
  MAX_JSON_NODES,
  MAX_TEXT_NODES,
  parseTags,
  shapeRules,
  targetText,
} from '../../src/background/a11y-format';

const node = (sel: string) => ({ html: `<i id="${sel}">`, target: [`#${sel}`] });

describe('shapeRules', () => {
  it('keeps axe order, counts all nodes and keeps ten', () => {
    const rules = shapeRules([
      { id: 'b', impact: 'minor', nodes: [node('x')] },
      { id: 'z', impact: 'critical', nodes: Array.from({ length: 12 }, (_, i) => node(`n${i}`)) },
      { id: 'a', impact: 'critical', nodes: [] },
      { id: 'm', impact: 'serious', nodes: [] },
    ]);
    expect(rules.map((r) => r.id)).toEqual(['b', 'z', 'a', 'm']);
    const z = rules.find((r) => r.id === 'z');
    expect(z?.nodeCount).toBe(12);
    expect(z?.nodes).toHaveLength(MAX_JSON_NODES);
  });

  it('takes the worst node impact when the rule has none (incomplete)', () => {
    const [r] = shapeRules([
      {
        id: 'color-contrast',
        impact: null,
        nodes: [
          { ...node('a'), impact: 'moderate' },
          { ...node('b'), impact: 'serious' },
        ],
      },
    ]);
    expect(r?.impact).toBe('serious');
    expect(shapeRules([{ id: 'x' }])[0]?.impact).toBe('unknown');
  });

  it('cuts html at 300 characters', () => {
    const [r] = shapeRules([{ id: 'x', nodes: [{ html: 'a'.repeat(500), target: ['#x'] }] }]);
    expect(r?.nodes[0]?.html).toHaveLength(300);
  });
});

describe('targetText', () => {
  it('marks frame (>>) and shadow (>>>) boundaries', () => {
    expect(targetText(['#a'])).toBe('#a');
    expect(targetText(['iframe#f', '#b'])).toBe('iframe#f >> #b');
    expect(targetText([['my-el', '#in']])).toBe('my-el >>> #in');
  });
});

describe('formatText', () => {
  const rules = shapeRules([
    {
      id: 'image-alt',
      impact: 'critical',
      help: 'Images must have alternative text',
      helpUrl: 'https://example.test/image-alt',
      nodes: Array.from({ length: 7 }, (_, i) => node(`i${i}`)),
    },
  ]);
  const first = rules[0];
  if (first?.nodes[0]) first.nodes[0].ref = 'e4';
  const data: A11yData = {
    axeVersion: '4.14.1',
    url: 'http://x.test/',
    counts: { violations: 1, incomplete: 1, passes: 3, inapplicable: 9 },
    violations: rules,
    incomplete: shapeRules([{ id: 'color-contrast', impact: null, help: 'h', helpUrl: 'u' }]),
  };

  it('prints most severe first', () => {
    const mixed = shapeRules([
      { id: 'b', impact: 'minor', help: 'h', helpUrl: 'u' },
      { id: 'a', impact: 'critical', help: 'h', helpUrl: 'u' },
    ]);
    const t = formatText({ ...data, violations: mixed }).split('\n');
    expect(t.findIndex((l) => l.startsWith('[critical]'))).toBeLessThan(
      t.findIndex((l) => l.startsWith('[minor]')),
    );
  });

  it('prints header, rules, a ref marker and a "more" line', () => {
    const t = formatText(data).split('\n');
    expect(t[0]).toBe('url: http://x.test/');
    expect(t[1]).toBe('axe-core: 4.14.1  violations: 1  incomplete: 1  passes: 3');
    expect(t).toContain('[critical] image-alt: Images must have alternative text (7 nodes)');
    expect(t).toContain('  - #i0 @e4');
    expect(t.filter((l) => l.startsWith('  - #i'))).toHaveLength(MAX_TEXT_NODES);
    expect(t).toContain('  … 2 more (use --json)');
    expect(t).toContain('incomplete (needs manual review):');
    expect(t).toContain('[unknown] color-contrast: h (0 nodes)');
  });
});

describe('parseTags', () => {
  it('splits and trims', () => {
    expect(parseTags(' wcag2a, wcag2aa ,,')).toEqual(['wcag2a', 'wcag2aa']);
  });
});
