import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, type ChromeMock } from '../helpers/chrome-mock';

let g: typeof import('../../src/background/guardrails');
let Args: typeof import('../../src/background/command').Args;
let mock: ChromeMock;

beforeEach(async () => {
  vi.resetModules();
  mock = installChromeMock();
  g = await import('../../src/background/guardrails');
  ({ Args } = await import('../../src/background/command'));
});

const args = (flags: Record<string, string | true> = {}) =>
  new Args([], new Map(Object.entries(flags)));

describe('policy storage', () => {
  it('defaults when nothing is stored, and coerces bad values', async () => {
    await g.loadGuardrails();
    expect(g.guardrails).toEqual({ maxOutput: 0 });
    mock.local.data.guardrails = { maxOutput: 'lots' };
    await g.loadGuardrails();
    expect(g.guardrails.maxOutput).toBe(0);
    mock.local.data.guardrails = { maxOutput: 500.5 };
    await g.loadGuardrails();
    expect(g.guardrails.maxOutput).toBe(0);
  });

  it('persists updates to chrome.storage.local', async () => {
    await g.updateGuardrails({ maxOutput: 2000 });
    expect(g.guardrails.maxOutput).toBe(2000);
    expect(mock.local.data.guardrails).toMatchObject({ maxOutput: 2000 });
  });
});

describe('--max-output', () => {
  it('uses the user default unless the flag is given', () => {
    expect(g.effectiveMaxOutput(args(), { maxOutput: 0 })).toBe(0);
    expect(g.effectiveMaxOutput(args(), { maxOutput: 100 })).toBe(100);
    expect(g.effectiveMaxOutput(args({ 'max-output': '30' }), { maxOutput: 100 })).toBe(30);
  });

  it('rejects non-positive or fractional values', () => {
    for (const v of ['0', '-5', '1.5', 'x']) {
      expect(() => g.effectiveMaxOutput(args({ 'max-output': v }))).toThrow(/--max-output/);
    }
  });

  it('truncates text with the upstream marker', () => {
    const r = g.limitOutput({ text: 'abcdefghij' }, 4);
    expect(r.text).toBe('abcd\n[truncated: showing 4 of 10 chars. Use --max-output to adjust]');
    expect(g.limitOutput({ text: 'abcd' }, 4).text).toBe('abcd');
    expect(g.limitOutput({ text: 'abcdefghij' }, 0).text).toBe('abcdefghij');
  });

  it('cuts long strings in JSON data, keeps urls whole and sets truncated', () => {
    const r = g.limitOutput(
      { text: 'x', data: { text: 'abcdefghij', origin: 'https://example.com/a/long/url', n: 3 } },
      5,
    );
    expect(r.data).toEqual({
      text: 'abcde\n[truncated: showing 5 of 10 chars. Use --max-output to adjust]',
      origin: 'https://example.com/a/long/url',
      n: 3,
      truncated: true,
    });
    const small = g.limitOutput({ data: { text: 'abc' } }, 5);
    expect(small.data).toEqual({ text: 'abc' });
  });
});
