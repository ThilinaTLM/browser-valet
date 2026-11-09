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
    expect(g.guardrails).toEqual({
      maxOutput: 0,
      contentBoundaries: false,
      allowedDomains: [],
      confirm: [],
    });
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
    expect(g.boundariesOn(pos(), { ...g.DEFAULT_GUARDRAILS })).toBe(false);
    const flag = new Args([], new Map([['content-boundaries', true as const]]));
    expect(g.boundariesOn(flag, { ...g.DEFAULT_GUARDRAILS })).toBe(true);
    expect(g.boundariesOn(pos(), { ...g.DEFAULT_GUARDRAILS, contentBoundaries: true })).toBe(true);
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

describe('allowed domains', () => {
  const ok = (patterns: string[], url: string) => g.urlAllowed(patterns, url);

  it('example.com matches the domain and its subdomains, not look-alikes', () => {
    const p = ['example.com'];
    expect(ok(p, 'https://example.com/')).toBe(true);
    expect(ok(p, 'https://www.example.com/a?b=1')).toBe(true);
    expect(ok(p, 'http://a.b.example.com:8080/')).toBe(true);
    expect(ok(p, 'https://evilexample.com/')).toBe(false);
    expect(ok(p, 'https://example.com.evil.test/')).toBe(false);
    expect(ok(p, 'https://evil.test/example.com')).toBe(false);
    expect(ok(p, 'https://user@evil.test:80@example.com/')).toBe(true); // host is example.com
    expect(ok(p, 'https://example.com@evil.test/')).toBe(false);
  });

  it('*.example.com matches subdomains only', () => {
    const p = ['*.example.com'];
    expect(ok(p, 'https://www.example.com/')).toBe(true);
    expect(ok(p, 'https://example.com/')).toBe(false);
  });

  it('host:port pins the host and the port (default ports count)', () => {
    expect(ok(['localhost:3000'], 'http://localhost:3000/x')).toBe(true);
    expect(ok(['localhost:3000'], 'http://localhost:3001/')).toBe(false);
    expect(ok(['localhost:3000'], 'http://localhost/')).toBe(false);
    expect(ok(['localhost:3000'], 'http://sub.localhost:3000/')).toBe(false);
    expect(ok(['example.com:443'], 'https://example.com/')).toBe(true);
    expect(ok(['example.com:443'], 'http://example.com/')).toBe(false);
    expect(ok(['[::1]:3000'], 'http://[::1]:3000/')).toBe(true);
    expect(ok(['localhost'], 'http://localhost:9999/')).toBe(true);
  });

  it('is case-insensitive and ignores a trailing dot in the host', () => {
    expect(ok(['example.com'], 'https://EXAMPLE.com./')).toBe(true);
    expect(g.normalizePattern(' HTTPS://Example.COM/path ')).toBe('example.com');
  });

  it('an empty list is unrestricted; otherwise only http(s) and about:blank are reachable', () => {
    expect(ok([], 'https://anything.test/')).toBe(true);
    expect(ok([], 'file:///etc/passwd')).toBe(true);
    expect(ok(['example.com'], 'about:blank')).toBe(true);
    expect(ok(['example.com'], 'file:///etc/passwd')).toBe(false);
    expect(ok(['example.com'], 'data:text/html,hi')).toBe(false);
    expect(ok(['example.com'], 'javascript:alert(1)')).toBe(false);
    expect(ok(['example.com'], 'not a url')).toBe(false);
  });

  it('rejects malformed patterns', () => {
    for (const bad of ['', '*', '*.', 'a b', 'exa$mple.com', 'example.com:abc', '*example.com']) {
      expect(g.normalizePattern(bad), bad).toBeUndefined();
    }
    expect(() => g.parseDomainList('example.com,*')).toThrow(/Invalid --allowed-domains/);
    expect(() => g.parseDomainList(' ')).toThrow(/at least one/);
    expect(g.parseDomainList('a.com, *.b.com localhost:3000')).toEqual([
      'a.com',
      '*.b.com',
      'localhost:3000',
    ]);
    expect(g.parseDomainList(undefined)).toBeUndefined();
  });

  it('agent flags can only narrow the user policy', () => {
    const user = ['example.com'];
    // user restricts, agent narrows further
    expect(g.blockedBy('https://example.com/', ['example.com'], user)).toBeUndefined();
    expect(g.blockedBy('https://a.example.com/', ['b.example.com'], user)).toBe('agent');
    // agent tries to widen: still blocked by the user
    expect(g.blockedBy('https://evil.test/', ['evil.test'], user)).toBe('user');
    expect(g.blockedBy('https://evil.test/', ['evil.test', 'example.com'], user)).toBe('user');
    // user unrestricted: the agent flag is the only restriction
    expect(g.blockedBy('https://evil.test/', ['example.com'], [])).toBe('agent');
    expect(g.blockedBy('https://evil.test/', undefined, [])).toBeUndefined();
  });

  it('stores validated patterns and refuses bad input', async () => {
    await g.updateGuardrails({ allowedDomains: ['Example.com', 'example.com', 'localhost:3000'] });
    expect(g.guardrails.allowedDomains).toEqual(['example.com', 'localhost:3000']);
    expect((mock.local.data.guardrails as { allowedDomains: string[] }).allowedDomains).toEqual([
      'example.com',
      'localhost:3000',
    ]);
    await expect(g.updateGuardrails({ allowedDomains: ['exmple$.com'] })).rejects.toThrow(
      /Invalid domain pattern/,
    );
    expect(g.guardrails.allowedDomains).toEqual(['example.com', 'localhost:3000']);
  });

  it('assertNavigable throws domain_blocked naming the policy', async () => {
    await g.updateGuardrails({ allowedDomains: ['example.com'] });
    const ctx = { agentAllowedDomains: undefined } as import('../../src/background/command').Ctx;
    expect(() => {
      g.assertNavigable(ctx, 'https://www.example.com/');
    }).not.toThrow();
    try {
      g.assertNavigable(ctx, 'https://evil.test/x');
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: 'domain_blocked' });
      expect((e as Error).message).toContain("user's allowed-domains policy");
      expect((e as Error).message).toContain('Allowed: example.com');
    }
    ctx.agentAllowedDomains = ['a.example.com'];
    expect(() => {
      g.assertNavigable(ctx, 'https://b.example.com/');
    }).toThrow(/your --allowed-domains/);
  });
});

describe('action confirmation', () => {
  const E = async () => {
    const stateMod = await import('../../src/background/state');
    const tabs = await import('../../src/background/tabs');
    await stateMod.loadState();
    return { stateMod, tabs };
  };
  const mkCtx = (over: Record<string, unknown> = {}) =>
    ({
      session: 'default',
      signal: new AbortController().signal,
      progress: () => undefined,
      described: 'eval (5 chars)',
      agentAllowedDomains: undefined,
      agentConfirm: undefined,
      tabId: undefined,
      ...over,
    }) as unknown as import('../../src/background/command').Ctx;

  it("the agent flag adds categories and can never remove the user's", () => {
    expect([...g.confirmRequired(undefined, ['eval'])]).toEqual(['eval']);
    expect([...g.confirmRequired(['upload'], ['eval'])].sort()).toEqual(['eval', 'upload']);
    expect([...g.confirmRequired([], [])]).toEqual([]);
  });

  it('parses --confirm-actions', () => {
    expect(g.parseConfirmList('eval, upload')).toEqual(['eval', 'upload']);
    expect(g.parseConfirmList(undefined)).toBeUndefined();
    expect(() => g.parseConfirmList('click')).toThrow(/Unknown --confirm-actions/);
    expect(() => g.parseConfirmList('')).toThrow(/at least one/);
  });

  it('stores only known categories', async () => {
    await g.updateGuardrails({ confirm: ['upload', 'bogus', 'eval'] as never });
    expect(g.guardrails.confirm).toEqual(['eval', 'upload']);
  });

  it('does not ask when the category is not in force', async () => {
    const { stateMod } = await E();
    await g.confirmCommand(mkCtx(), 'eval', args());
    await g.confirmCommand(mkCtx(), 'click', args());
    expect(stateMod.state.approvals).toEqual([]);
  });

  it('asks with the redacted command and runs on allow', async () => {
    const { stateMod, tabs } = await E();
    await g.updateGuardrails({ confirm: ['eval'] });
    const p = g.confirmCommand(mkCtx(), 'eval', args());
    await mock.flush();
    const [a] = stateMod.state.approvals;
    expect(a?.action).toEqual({ category: 'eval', command: 'eval (5 chars)' });
    tabs.decide(a?.id ?? '', true);
    await p;
    expect(stateMod.state.approvals).toEqual([]);
  });

  it('fails with code denied on deny, and the flag alone is enough to ask', async () => {
    const { stateMod, tabs } = await E();
    const p = g.confirmCommand(mkCtx({ agentConfirm: ['upload'] }), 'upload', args());
    const failed = p.then(
      () => undefined,
      (e: unknown) => e,
    );
    await mock.flush();
    tabs.decide(stateMod.state.approvals[0]?.id ?? '', false);
    expect(await failed).toMatchObject({ code: 'denied' });
    expect(stateMod.state.approvals).toEqual([]);
  });

  it('an approval tied to a tab fails when the tab closes', async () => {
    const { stateMod } = await E();
    stateMod.meta(7);
    stateMod.session('default').tab = 7;
    await g.updateGuardrails({ confirm: ['eval'] });
    const failed = g.confirmCommand(mkCtx(), 'eval', args()).then(
      () => undefined,
      (e: unknown) => e,
    );
    await mock.flush();
    expect(stateMod.state.approvals[0]?.tabId).toBe(7);
    mock.events.tabsOnRemoved.fire(7);
    expect(((await failed) as Error).message).toMatch(/tab was closed/);
  });

  it('asks once per new site, remembers it, and never asks for a blocked site', async () => {
    const { stateMod, tabs } = await E();
    await g.updateGuardrails({ confirm: ['navigate-new-site'], allowedDomains: ['example.com'] });
    const ctx = mkCtx({ described: 'open https://www.example.com/a' });
    const p = g.guardNavigation(ctx, 'https://www.example.com/a');
    await mock.flush();
    expect(stateMod.state.approvals[0]?.action).toMatchObject({
      category: 'navigate-new-site',
      site: 'example.com',
    });
    tabs.decide(stateMod.state.approvals[0]?.id ?? '', true);
    await p;
    expect(stateMod.session('default').sites).toEqual(['example.com']);
    await g.guardNavigation(ctx, 'https://example.com/b'); // same site (www. ignored): no card
    expect(stateMod.state.approvals).toEqual([]);
    await expect(g.guardNavigation(ctx, 'https://evil.test/')).rejects.toMatchObject({
      code: 'domain_blocked',
    });
    expect(stateMod.state.approvals).toEqual([]);
  });

  it('wait --fn counts as eval', () => {
    expect(g.commandCategory('wait', args({ fn: 'x' }))).toBe('eval');
    expect(g.commandCategory('wait', args())).toBeUndefined();
    expect(g.commandCategory('eval', args())).toBe('eval');
    expect(g.commandCategory('upload', args())).toBe('upload');
  });

  it('records visited sites even when the category is off', async () => {
    const { stateMod } = await E();
    await g.guardNavigation(mkCtx(), 'https://a.test/');
    expect(stateMod.session('default').sites).toEqual(['a.test']);
  });
});
