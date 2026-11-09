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
    expect(g.guardrails).toEqual({ maxOutput: 0, contentBoundaries: false });
    mock.local.data.guardrails = { maxOutput: 'lots' };
    await g.loadGuardrails();
    expect(g.guardrails.maxOutput).toBe(0);
    mock.local.data.guardrails = { maxOutput: 500.5 };
    await g.loadGuardrails();
    expect(g.guardrails.maxOutput).toBe(0);
  });

  it('persists updates to chrome.storage.local', async () => {
    await g.updateGuardrails({ ...g.DEFAULT_GUARDRAILS, maxOutput: 2000 });
    expect(g.guardrails.maxOutput).toBe(2000);
    expect(mock.local.data.guardrails).toMatchObject({ ...g.DEFAULT_GUARDRAILS, maxOutput: 2000 });
  });
});

describe('--max-output', () => {
  it('uses the user default unless the flag is given', () => {
    expect(g.effectiveMaxOutput(args(), { ...g.DEFAULT_GUARDRAILS, maxOutput: 0 })).toBe(0);
    expect(g.effectiveMaxOutput(args(), { ...g.DEFAULT_GUARDRAILS, maxOutput: 100 })).toBe(100);
    expect(
      g.effectiveMaxOutput(args({ 'max-output': '30' }), {
        ...g.DEFAULT_GUARDRAILS,
        maxOutput: 100,
      }),
    ).toBe(30);
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

describe('content boundaries', () => {
  const pos = (...p: string[]) => new Args(p, new Map());
  const text = (t: string, data?: unknown) => ({ text: t, data });
  const nonceRe = /nonce=([0-9a-f]{32}) /;

  it('wraps in the upstream marker format with the origin', () => {
    const w = g.wrapContent('hello', { nonce: 'abc', origin: 'https://x.test/' });
    expect(w).toBe(
      '--- AGENT_BROWSER_PAGE_CONTENT nonce=abc origin=https://x.test/ ---\nhello\n--- END_AGENT_BROWSER_PAGE_CONTENT nonce=abc ---',
    );
  });

  it('uses a fresh random nonce per call', () => {
    expect(g.newNonce()).toMatch(/^[0-9a-f]{32}$/);
    expect(g.newNonce()).not.toBe(g.newNonce());
  });

  it('is off by default; on by the flag or the user setting', () => {
    expect(g.boundariesOn(pos(), { maxOutput: 0, contentBoundaries: false })).toBe(false);
    const flag = new Args([], new Map([['content-boundaries', true as const]]));
    expect(g.boundariesOn(flag, { maxOutput: 0, contentBoundaries: false })).toBe(true);
    expect(g.boundariesOn(pos(), { maxOutput: 0, contentBoundaries: true })).toBe(true);
  });

  it('classifies page-derived commands only', () => {
    const yes: [string, string[]][] = [
      ['snapshot', []],
      ['read', []],
      ['console', []],
      ['errors', []],
      ['eval', ['1']],
      ['get', ['text', 'body']],
      ['get', ['html']],
      ['get', ['value', '@e1']],
      ['get', ['attr', '@e1', 'href']],
      ['network', ['request', '3']],
    ];
    for (const [c, p] of yes) expect(g.isPageContent(c, pos(...p), {}), c).toBe(true);
    const no: [string, string[]][] = [
      ['get', ['title']],
      ['get', ['url']],
      ['get', ['count', 'li']],
      ['tab', []],
      ['click', ['@e1']],
      ['network', ['requests']],
      ['dialog', ['accept']],
    ];
    for (const [c, p] of no) expect(g.isPageContent(c, pos(...p), {}), c).toBe(false);
    expect(g.isPageContent('dialog', pos('status'), { data: { hasDialog: true } })).toBe(true);
    expect(g.isPageContent('dialog', pos('status'), { data: { hasDialog: false } })).toBe(false);
  });

  it('wraps text mode and reports _boundary for json, leaving data alone', async () => {
    await g.updateGuardrails({ contentBoundaries: true });
    const r = { text: 'body', data: { origin: 'https://o.test/', text: 'body' } };
    const t = await g.applyBoundaries('get', pos('text'), r, false, undefined);
    expect(t.result.text).toMatch(
      /^--- AGENT_BROWSER_PAGE_CONTENT nonce=[0-9a-f]{32} origin=https:\/\/o\.test\/ ---\nbody\n--- END_AGENT_BROWSER_PAGE_CONTENT nonce=[0-9a-f]{32} ---$/,
    );
    expect(t.result.text?.match(nonceRe)?.[1]).toBe(t.boundary?.nonce);
    const j = await g.applyBoundaries('get', pos('text'), r, true, undefined);
    expect(j.result).toBe(r);
    expect(j.boundary).toMatchObject({ origin: 'https://o.test/' });
  });

  it('leaves other commands and empty output alone, and falls back to unknown', async () => {
    await g.updateGuardrails({ contentBoundaries: true });
    const a = await g.applyBoundaries('get', pos('title'), text('T'), false, undefined);
    expect(a.boundary).toBeUndefined();
    const b = await g.applyBoundaries('errors', pos(), text(''), false, undefined);
    expect(b.boundary).toBeUndefined();
    const c = await g.applyBoundaries('eval', pos('1'), text('1'), false, undefined);
    expect(c.boundary?.origin).toBe('unknown');
  });
});
