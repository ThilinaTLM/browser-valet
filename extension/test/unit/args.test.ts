import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from '../helpers/chrome-mock';

type Command = typeof import('../../src/background/command');
let c: Command;

const flags: import('../../src/background/command').Flag[] = [
  { name: 'interactive', short: 'i', type: 'bool', desc: '' },
  { name: 'compact', short: 'c', type: 'bool', desc: '' },
  { name: 'selector', short: 's', type: 'string', desc: '' },
  { name: 'depth', type: 'string', desc: '' },
];

beforeEach(async () => {
  vi.resetModules();
  installChromeMock();
  c = await import('../../src/background/command');
});

describe('parseArgs', () => {
  it('splits positionals and flags', () => {
    const a = c.parseArgs(['@e1', '--selector', 'main', 'x'], flags);
    expect(a.pos).toEqual(['@e1', 'x']);
    expect(a.str('selector')).toBe('main');
  });

  it('supports --flag=value, short flags and combined bool shorts', () => {
    const a = c.parseArgs(['--depth=3', '-s', 'nav', '-ic'], flags);
    expect(a.str('depth')).toBe('3');
    expect(a.str('selector')).toBe('nav');
    expect(a.has('interactive')).toBe(true);
    expect(a.has('compact')).toBe(true);
  });

  it('knows the global flags', () => {
    const a = c.parseArgs(['--json', '--timeout', '500', '-h'], []);
    expect(a.has('json')).toBe(true);
    expect(a.num('timeout')).toBe(500);
    expect(a.has('help')).toBe(true);
  });

  it('treats negative numbers and a lone "-" as values', () => {
    expect(c.parseArgs(['-5', '-', '-0.5'], flags).pos).toEqual(['-5', '-', '-0.5']);
  });

  it('treats everything after -- as positional', () => {
    const a = c.parseArgs(['--', '--json', '-i'], flags);
    expect(a.pos).toEqual(['--json', '-i']);
    expect(a.has('json')).toBe(false);
  });

  it('rejects unknown flags and missing values', () => {
    expect(() => c.parseArgs(['--nope'], flags)).toThrow('Unknown flag: --nope');
    expect(() => c.parseArgs(['-z'], flags)).toThrow('Unknown flag: -z');
    expect(() => c.parseArgs(['--depth'], flags)).toThrow('--depth needs a value');
  });

  it('a bool flag ignores an inline value and never consumes the next token', () => {
    const a = c.parseArgs(['-i', 'text'], flags);
    expect(a.pos).toEqual(['text']);
  });

  it('num() validates, need() names the missing argument', () => {
    expect(() => c.parseArgs(['--depth', 'abc'], flags).num('depth')).toThrow(
      '--depth must be a number',
    );
    expect(c.parseArgs([], flags).num('depth')).toBeUndefined();
    expect(() => c.parseArgs([], flags).need(0, 'target')).toThrow('Missing target');
    for (const f of [
      () => c.parseArgs([], flags).need(0, 'target'),
      () => c.parseArgs(['--depth', 'abc'], flags).num('depth'),
      () => c.parseArgs(['--nope'], flags),
      () => c.parseArgs(['--depth'], flags),
    ]) {
      expect(f).toThrow(expect.objectContaining({ code: 'bad_args' }));
    }
  });
});
