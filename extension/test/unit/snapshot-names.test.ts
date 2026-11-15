import { describe, expect, it } from 'vitest';
import { dedupeName, isLayoutRole, mapRole, shortHref } from '../../src/background/snapshot-names';

describe('dedupeName', () => {
  it('collapses a phrase repeated twice', () => {
    expect(dedupeName('Hours Hours')).toBe('Hours');
    expect(dedupeName('Show time picker Show time picker')).toBe('Show time picker');
  });
  it('leaves other names alone', () => {
    expect(dedupeName('Hours Minutes')).toBe('Hours Minutes');
    expect(dedupeName('a a a')).toBe('a a a');
    expect(dedupeName('Hours')).toBe('Hours');
    expect(dedupeName('')).toBe('');
  });
});

describe('roles', () => {
  it('maps Chrome-internal roles', () => {
    expect(mapRole('InputTime')).toBe('group');
    expect(mapRole('button')).toBe('button');
    expect(isLayoutRole('LayoutTableCell')).toBe(true);
    expect(isLayoutRole('LayoutTable')).toBe(true);
    expect(isLayoutRole('table')).toBe(false);
  });
});

describe('shortHref', () => {
  it('uses path and query for same-origin links', () => {
    expect(shortHref('vote?id=5&how=up', 'https://news.ycombinator.com/item?id=1')).toBe(
      '/vote?id=5&how=up',
    );
  });
  it('drops the scheme for other origins and truncates', () => {
    expect(shortHref('https://a.org/x', 'https://b.org/')).toBe('a.org/x');
    const long = shortHref(`/${'x'.repeat(100)}`, 'https://b.org/');
    expect(long).toHaveLength(60);
    expect(long.endsWith('…')).toBe(true);
  });
});
