import { describe, expect, it } from 'vitest';
import { filterSections, outline, truncate } from '../../src/background/read-format';

const MD = [
  '# Guide',
  '',
  'Intro.',
  '',
  '## Auth',
  '',
  'Use tokens.',
  '',
  '```',
  '# not a heading',
  '```',
  '',
  '### Token details',
  '',
  'Tokens expire.',
  '',
  '## Install',
  '',
  'Download it.',
].join('\n');

describe('read-format', () => {
  it('outline nests by heading level and ignores code fences', () => {
    expect(outline(MD, 'http://x/')).toBe(
      '# Outline\n\nSource: http://x/\n\n- Guide\n  - Auth\n    - Token details\n  - Install',
    );
  });

  it('filter returns the matching section with its subsections', () => {
    const out = filterSections(MD, 'AUTH');
    expect(out.startsWith('## Auth')).toBe(true);
    expect(out).toContain('### Token details');
    expect(out).not.toContain('## Install');
    expect(out).not.toContain('Intro.');
  });

  it('filter matches body text and does not repeat nested matches', () => {
    expect(filterSections(MD, 'expire')).toBe('### Token details\n\nTokens expire.');
    expect(filterSections(MD, 'download')).toBe('## Install\n\nDownload it.');
    expect(filterSections(MD, 'tokens')).toContain('### Token details');
    expect(filterSections(MD, 'tokens')).toMatch(/^## Auth/);
  });

  it('filter with no match', () => {
    expect(filterSections(MD, 'zzz')).toBe('No matching page sections');
  });

  it('truncate adds a marker only when needed', () => {
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('abcdef', 3)).toBe(
      'abc\n[truncated: showing 3 of 6 chars. Use --max-output to adjust]',
    );
  });
});
