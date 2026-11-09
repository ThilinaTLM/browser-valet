import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from '../helpers/chrome-mock';

let setLabel: typeof import('../../src/background/commands/navigation').setLabel;
let s: typeof import('../../src/background/state');

beforeEach(async () => {
  vi.resetModules();
  installChromeMock();
  s = await import('../../src/background/state');
  ({ setLabel } = await import('../../src/background/commands/navigation'));
});

describe('tab labels', () => {
  it.each(['docs', 'Docs-2', 'a_b', 'x'])('accepts %s', (label) => {
    setLabel(1, label);
    expect(s.meta(1).label).toBe(label);
    expect(s.findTab(label)).toBe(1);
  });

  it.each(['', '1abc', '-x', 'a b', 't3', 'T12', 'a.b'])('rejects %j', (label) => {
    expect(() => {
      setLabel(1, label);
    }).toThrow('Labels start with a letter');
  });

  it('allows t-prefixed words that are not t<N>', () => {
    setLabel(1, 'tab1x');
    setLabel(2, 'top');
    expect(s.findTab('top')).toBe(2);
  });

  it('rejects a label used by another tab, but allows re-labelling the same tab', () => {
    setLabel(1, 'docs');
    expect(() => {
      setLabel(2, 'docs');
    }).toThrow('Label "docs" is in use');
    setLabel(1, 'docs');
  });

  it('tabs resolve by tN or label', () => {
    setLabel(5, 'work');
    expect(s.findTab(s.meta(5).tid)).toBe(5);
    expect(s.findTab('work')).toBe(5);
    expect(s.findTab('nope')).toBeUndefined();
  });
});
