import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChromeMock, installChromeMock } from '../helpers/chrome-mock';

let mock: ChromeMock;
let net: typeof import('../../src/background/network');
let cdp: typeof import('../../src/background/cdp');

beforeEach(async () => {
  vi.resetModules();
  mock = installChromeMock();
  cdp = await import('../../src/background/cdp');
  net = await import('../../src/background/network');
});

const fire = (method: string, params: unknown, tabId = 1): void => {
  mock.events.debuggerOnEvent.fire({ tabId } as never, method as never, params as never);
};

const request = (id: string, url: string, extra: Record<string, unknown> = {}, tabId = 1): void => {
  fire(
    'Network.requestWillBeSent',
    {
      requestId: id,
      type: 'Fetch',
      timestamp: 10,
      wallTime: 1000,
      request: { url, method: 'GET', headers: {}, ...extra },
    },
    tabId,
  );
};

describe('redaction', () => {
  it('redacts credential headers by name, case-insensitively', () => {
    const h = net.redactHeaders({
      Cookie: 'a=1',
      'Set-Cookie': 'b=2',
      Authorization: 'Bearer x',
      'Proxy-Authorization': 'y',
      'X-API-Key': 'k',
      'X-CSRF-Token': 'c',
      'x-xsrf-token': 'd',
      'X-Auth-Token': 'e',
      'Content-Type': 'text/plain',
      ':authority': 'example.com',
    });
    expect(
      Object.entries(h)
        .filter(([, v]) => v === net.REDACTED)
        .map(([k]) => k),
    ).toHaveLength(8);
    expect(h['Content-Type']).toBe('text/plain');
    expect(h[':authority']).toBe('example.com');
  });

  it('redacts secret keys in JSON, form and multipart request bodies', () => {
    expect(
      JSON.parse(net.redactRequestBody('{"user":"a","password":"p","n":[{"apiKey":"k"}]}')),
    ).toEqual({
      user: 'a',
      password: net.REDACTED,
      n: [{ apiKey: net.REDACTED }],
    });
    expect(
      net.redactRequestBody(
        'a=1&Password=p&access%5Ftoken=t&b=2',
        'application/x-www-form-urlencoded',
      ),
    ).toBe(`a=1&Password=${net.REDACTED}&access%5Ftoken=${net.REDACTED}&b=2`);
    const mp =
      '--B\r\nContent-Disposition: form-data; name="secret"\r\n\r\nshh\r\n--B\r\nContent-Disposition: form-data; name="x"\r\n\r\nok\r\n--B--';
    const out = net.redactRequestBody(mp, 'multipart/form-data; boundary=B');
    expect(out).not.toContain('shh');
    expect(out).toContain('ok');
    expect(net.redactRequestBody('plain text')).toBe('plain text');
  });

  it('redacts token fields in JSON response bodies only', () => {
    const out = JSON.parse(
      net.redactResponseBody(
        JSON.stringify({
          access_token: 'a',
          refreshToken: 'r',
          id_token: 'i',
          client_secret: 's',
          token: 't',
          password: 'p',
          ok: 1,
          nested: { token: 'x' },
        }),
      ),
    ) as Record<string, unknown>;
    expect(out).toMatchObject({
      access_token: net.REDACTED,
      refreshToken: net.REDACTED,
      id_token: net.REDACTED,
      client_secret: net.REDACTED,
      token: net.REDACTED,
      password: net.REDACTED,
      ok: 1,
    });
    expect(out.nested).toEqual({ token: net.REDACTED });
    expect(net.redactResponseBody('<html>token</html>')).toBe('<html>token</html>');
  });

  it('redacts secret query values in URLs', () => {
    expect(net.redactUrl('http://x/a?access_token=1&page=2#frag')).toBe(
      `http://x/a?access_token=${net.REDACTED}&page=2#frag`,
    );
    expect(net.redactUrl('http://x/a')).toBe('http://x/a');
  });
});

describe('status filter', () => {
  it('parses 200, 2xx and ranges', () => {
    expect(net.parseStatus('2xx')(204)).toBe(true);
    expect(net.parseStatus('2xx')(404)).toBe(false);
    expect(net.parseStatus('400-499')(404)).toBe(true);
    expect(net.parseStatus('400-499')(500)).toBe(false);
    expect(net.parseStatus('500')(500)).toBe(true);
    expect(() => net.parseStatus('wat')).toThrow('--status');
  });
});

describe('recording', () => {
  it('starts lazily with Network.enable, once', async () => {
    expect(net.isRecording(1)).toBe(false);
    expect(await net.startRecording(1)).toBe(true);
    expect(await net.startRecording(1)).toBe(false);
    const enables = mock.chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>;
    expect(enables.mock.calls.filter((c) => c[1] === 'Network.enable')).toHaveLength(1);
  });

  it('ignores events for tabs that are not recording', () => {
    request('r1', 'http://x/');
    expect(net.list(1)).toEqual([]);
  });

  it('assembles an entry from events (ExtraInfo first or last) and redacts on ingest', async () => {
    await net.startRecording(1);
    fire('Network.requestWillBeSentExtraInfo', {
      requestId: 'r1',
      headers: { Cookie: 'sid=SECRET', Accept: '*/*' },
    });
    request('r1', 'http://x/api?token=SECRET', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      postData: '{"password":"SECRET","a":1}',
    });
    fire('Network.responseReceived', {
      requestId: 'r1',
      type: 'Fetch',
      response: {
        status: 404,
        mimeType: 'application/json',
        headers: { 'content-type': 'application/json' },
      },
    });
    fire('Network.responseReceivedExtraInfo', {
      requestId: 'r1',
      headers: { 'set-cookie': 'sid=SECRET' },
    });
    fire('Network.loadingFinished', { requestId: 'r1', timestamp: 10.25, encodedDataLength: 42 });
    const [e] = net.list(1);
    expect(JSON.stringify(e)).not.toContain('SECRET');
    expect(e).toMatchObject({
      id: 'r1',
      method: 'POST',
      status: 404,
      size: 42,
      durationMs: 250,
      finished: true,
    });
    expect(e?.requestHeaders.Accept).toBe('*/*');
    expect(net.line(e as never)).toBe(`[r1] POST http://x/api?token=${net.REDACTED} (Fetch) 404`);
  });

  it('filters by url, type, method and status', async () => {
    await net.startRecording(1);
    request('a', 'http://x/api/one');
    request('b', 'http://x/page', { method: 'POST' });
    fire('Network.responseReceived', {
      requestId: 'a',
      type: 'XHR',
      response: { status: 200, headers: {} },
    });
    fire('Network.responseReceived', {
      requestId: 'b',
      type: 'Document',
      response: { status: 500, headers: {} },
    });
    const ids = (f: Parameters<typeof net.list>[1]) => net.list(1, f).map((e) => e.id);
    expect(ids({ filter: 'API' })).toEqual(['a']);
    expect(ids({ types: ['document'] })).toEqual(['b']);
    expect(ids({ types: ['xhr', 'fetch'] })).toEqual(['a']);
    expect(ids({ method: 'post' })).toEqual(['b']);
    expect(ids({ status: net.parseStatus('5xx') })).toEqual(['b']);
  });

  it('keeps redirect hops as separate entries', async () => {
    await net.startRecording(1);
    request('r', 'http://x/old');
    fire('Network.requestWillBeSent', {
      requestId: 'r',
      type: 'Document',
      timestamp: 11,
      request: { url: 'http://x/new', method: 'GET', headers: {} },
      redirectResponse: { status: 302, headers: {} },
    });
    expect(net.list(1).map((e) => `${e.id} ${e.url} ${e.status ?? ''}`)).toEqual([
      'r~1 http://x/old 302',
      'r http://x/new ',
    ]);
  });

  it('keeps at most 500 entries per tab', async () => {
    await net.startRecording(1);
    for (let i = 0; i < 520; i++) request(`r${i}`, `http://x/${i}`);
    const all = net.list(1);
    expect(all).toHaveLength(500);
    expect(all[0]?.id).toBe('r20');
    expect(net.getEntry(1, 'r0')).toBeUndefined();
  });

  it('clearLog empties the log but keeps recording', async () => {
    await net.startRecording(1);
    request('a', 'http://x/');
    net.clearLog(1);
    expect(net.list(1)).toEqual([]);
    expect(net.isRecording(1)).toBe(true);
  });

  it('drops the buffer on cdp.detach (revoke) and on a Chrome-side detach', async () => {
    await net.startRecording(1);
    await net.startRecording(2);
    request('a', 'http://x/');
    await cdp.detach(1);
    expect(net.isRecording(1)).toBe(false);
    expect(net.list(1)).toEqual([]);
    mock.events.debuggerOnDetach.fire({ tabId: 2 } as never, 'target_closed' as never);
    expect(net.isRecording(2)).toBe(false);
  });
});

describe('responseBody', () => {
  const finished = (over: Record<string, unknown> = {}) =>
    ({
      id: 'r',
      method: 'GET',
      url: 'u',
      type: 'Fetch',
      requestHeaders: {},
      responseHeaders: {},
      finished: true,
      status: 200,
      mimeType: 'application/json',
      ...over,
    }) as never;
  const body = (b: string, base64Encoded = false): void => {
    const send = mock.chrome.debugger.sendCommand as unknown as {
      mockImplementation(fn: (t: unknown, m: string) => unknown): void;
    };
    send.mockImplementation((_t, m) =>
      Promise.resolve(m === 'Network.getResponseBody' ? { body: b, base64Encoded } : {}),
    );
  };

  it('returns redacted, capped text', async () => {
    body('{"access_token":"zzz","m":"hi"}');
    const r = await net.responseBody(1, finished());
    expect(r.text).not.toContain('zzz');
    expect(r.text).toContain('"m": "hi"');
    body('x'.repeat(net.MAX_BODY_CHARS + 10));
    const big = await net.responseBody(1, finished({ mimeType: 'text/plain' }));
    expect(big.text).toHaveLength(net.MAX_BODY_CHARS);
    expect(big.truncated).toBe(true);
  });

  it('explains binary, unfinished, failed and evicted bodies', async () => {
    expect((await net.responseBody(1, finished({ mimeType: 'image/png' }))).note).toContain(
      'binary',
    );
    body('AAAA', true);
    expect((await net.responseBody(1, finished({ mimeType: undefined }))).note).toContain('binary');
    expect((await net.responseBody(1, finished({ finished: false }))).note).toContain(
      'not finished',
    );
    expect((await net.responseBody(1, finished({ failed: 'net::ERR_FAILED' }))).note).toContain(
      'failed',
    );
    (mock.chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('No resource'),
    );
    expect((await net.responseBody(1, finished())).note).toContain('evicted');
  });
});

describe('network command', () => {
  it('logs only `network request <id>` / flag-less requests in the activity log', async () => {
    const { Args, logArgs, parseArgs } = await import('../../src/background/command');
    const { networkCommands } = await import('../../src/background/commands/network');
    const cmd = networkCommands[0];
    if (!cmd) throw new Error('missing');
    const req = {} as never;
    expect(Args).toBeDefined();
    expect(logArgs(cmd, parseArgs(['request', 'abc.1'], cmd.flags ?? []), req)).toEqual([
      'request',
      'abc.1',
    ]);
    expect(
      logArgs(
        cmd,
        parseArgs(['requests', '--filter', 'secret-search', '--status', '4xx'], cmd.flags ?? []),
        req,
      ),
    ).toEqual(['requests', '--filter', '•••', '--status', '4xx']);
  });
});
