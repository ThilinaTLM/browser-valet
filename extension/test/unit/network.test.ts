import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChromeMock, installChromeMock } from '../helpers/chrome-mock';

let mock: ChromeMock;
let net: typeof import('../../src/background/network');
let cdp: typeof import('../../src/background/cdp');

beforeEach(async () => {
  vi.resetModules();
  mock = installChromeMock();
  cdp = await import('../../src/background/cdp');
  const st = await import('../../src/background/state');
  for (const id of [1, 2, 3]) st.meta(id).control = 'agent'; // attach only serves controlled tabs
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

  it('redacts wider response token keys but keeps harmless ones', () => {
    const out = JSON.parse(
      net.redactResponseBody(
        JSON.stringify({
          api_token: 1,
          auth_token: 1,
          session_token: 1,
          csrf_token: 1,
          apiKey: 1,
          api_key: 1,
          private_key: 1,
          sessionId: 1,
          session_id: 1,
          jwt: 1,
          app_secret: 1,
          clientSecret: 1,
          tokens_used: 5,
          token_count: 6,
          token_type: 'Bearer',
          expires_in: 3600,
          nextPageToken: 'n',
          deep: [{ jwt: 'x', keep: 1 }],
        }),
      ),
    ) as Record<string, unknown>;
    for (const k of [
      'api_token',
      'auth_token',
      'session_token',
      'csrf_token',
      'apiKey',
      'api_key',
      'private_key',
      'sessionId',
      'session_id',
      'jwt',
      'app_secret',
      'clientSecret',
    ])
      expect(out[k]).toBe(net.REDACTED);
    expect(out).toMatchObject({
      tokens_used: 5,
      token_count: 6,
      token_type: 'Bearer',
      expires_in: 3600,
      nextPageToken: 'n',
    });
    expect(out.deep).toEqual([{ jwt: net.REDACTED, keep: 1 }]);
  });

  it('redacts form-encoded response bodies', () => {
    const body = 'access_token=SECRET&token_type=bearer&expires_in=3600&refresh_token=R%2F1';
    const out = net.redactResponseBody(body, 'application/x-www-form-urlencoded');
    expect(out).toBe(
      `access_token=${net.REDACTED}&token_type=bearer&expires_in=3600&refresh_token=${net.REDACTED}`,
    );
    expect(net.redactResponseBody(body, 'text/plain')).not.toContain('SECRET');
    expect(net.redactResponseBody('a sentence = fine')).toBe('a sentence = fine');
  });

  it('redacts JSON behind an XSSI prefix', () => {
    const out = net.redactResponseBody(
      ")]}'\n" + JSON.stringify({ access_token: 'SECRET', ok: 1 }),
    );
    expect(out.startsWith(")]}'\n")).toBe(true);
    expect(out).not.toContain('SECRET');
    expect(out).toContain('"ok": 1');
  });

  it('redacts a >8 KB JSON request body before truncating', async () => {
    await net.startRecording(1);
    const big = JSON.stringify({ password: 'SECRET1', filler: 'x'.repeat(9000), token: 'SECRET2' });
    request('big', 'http://x/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      postData: big,
    });
    const [e] = net.list(1);
    expect(e?.postData).not.toContain('SECRET');
    expect(e?.postData).toContain(net.REDACTED);
    expect(e?.postData?.length).toBe(net.MAX_POST_DATA);
    expect(e?.postDataTruncated).toBe(true);
    request('small', 'http://x/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      postData: '{"a":1}',
    });
    expect(net.list(1).find((x) => x.id === 'small')?.postDataTruncated).toBe(false);
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

describe('redaction hardening', () => {
  const t0 = (): number => performance.now();

  it('form check is linear (no ReDoS)', () => {
    const evil = `a=${'&a='.repeat(50)} x`;
    const s = t0();
    expect(net.redactResponseBody(evil)).toBe(evil);
    expect(t0() - s).toBeLessThan(200);
  });

  it('leaves form-looking text with whitespace unchanged', () => {
    const t = '  token=abc and more\n';
    expect(net.redactResponseBody(t, 'text/plain')).toBe(t);
    const untouched = '  a=1&b=2  \n';
    expect(net.redactResponseBody(untouched, 'text/plain')).toBe(untouched);
  });

  it('redacts every listed response key; keeps harmless ones', () => {
    const secret = [
      'SecretKey',
      'SecretAccessKey',
      'x-amz-security-token',
      'x-amz-signature',
      'x-api-key',
      'x-auth-token',
      'Cookie',
      'secretKey',
      'secret_key',
      'accessKey',
      'sessionKey',
      'encryption_key',
      'signing_key',
      'new_password',
      'current_password',
      'password_confirmation',
      'jwtToken',
      'personal_access_token',
      'authenticity_token',
      'mfa_token',
      'reset_token',
      'verification_token',
      'customToken',
      'firebaseToken',
      'sasToken',
      '_csrf',
      'csrf',
      'credentials',
      'device_code',
      'authorization_code',
      'client_assertion',
      'assertion',
      'signature',
      'code_verifier',
      'api_token',
      'auth_token',
      'session_token',
      'csrf_token',
      'apiKey',
      'api_key',
      'private_key',
      'sessionId',
      'session_id',
      'jwt',
      'app_secret',
      'access_token',
      'refresh_token',
      'id_token',
      'password',
      'client_secret',
    ];
    const visible = {
      tokens_used: 1,
      token_count: 2,
      token_type: 'Bearer',
      expires_in: 3,
      code: 'US',
      refresh: 'x',
      pageToken: 'p',
      nextPageToken: 'n',
      continuation_token: 'c',
      syncToken: 's',
      resumeToken: 'r',
      cursorToken: 'k',
      name: 'n',
    };
    const input: Record<string, unknown> = { ...visible };
    for (const k of secret) input[k] = 'SECRET';
    const out = JSON.parse(net.redactResponseBody(JSON.stringify(input))) as Record<
      string,
      unknown
    >;
    for (const k of secret) expect(out[k], k).toBe(net.REDACTED);
    expect(out).toMatchObject(visible);
  });

  it('redacts secret keys beyond 32 KB before truncating', async () => {
    const filler = 'x'.repeat(net.MAX_BODY_CHARS + 100);
    const send = mock.chrome.debugger.sendCommand as unknown as {
      mockImplementation(fn: (t: unknown, m: string) => unknown): void;
    };
    send.mockImplementation((_t, m) =>
      Promise.resolve(
        m === 'Network.getResponseBody'
          ? { body: JSON.stringify({ filler, access_token: 'SECRET' }), base64Encoded: false }
          : {},
      ),
    );
    const r = await net.responseBody(1, {
      id: 'r',
      method: 'GET',
      url: 'u',
      type: 'Fetch',
      requestHeaders: {},
      responseHeaders: {},
      finished: true,
      status: 200,
      mimeType: 'application/json',
    });
    expect(r.truncated).toBe(true);
    expect(r.text).not.toContain('SECRET');
  });

  it('redacts NDJSON, SSE and JSONP bodies by key/value pairs', () => {
    const nd = '{"access_token":"SECRET1","a":1}\n{"id":2,"password":"SECRET2"}\n';
    const o1 = net.redactResponseBody(nd, 'application/x-ndjson');
    expect(o1).not.toContain('SECRET');
    expect(o1).toContain('"a":1');
    const sse = 'event: m\ndata: {"session_id":"SECRET3","ok":true}\n\n';
    const o2 = net.redactResponseBody(sse, 'text/event-stream');
    expect(o2).not.toContain('SECRET3');
    expect(o2).toContain('"ok":true');
    const o3 = net.redactResponseBody(
      'cb({"jwt":"SECRET4","token_type":"Bearer"});',
      'application/javascript',
    );
    expect(o3).not.toContain('SECRET4');
    expect(o3).toContain('"token_type":"Bearer"');
    expect(
      net.redactResponseBody('{"a":1}\n{"secret":{"k":"SECRET5"}}', 'application/x-ndjson'),
    ).not.toContain('SECRET5');
  });

  it.each([")]}'\n", ")]}',\n", 'while(1);', 'for(;;);', 'for (;;);\n', '{}&& '])(
    'handles XSSI prefix %j',
    (prefix) => {
      const out = net.redactResponseBody(
        `${prefix}${JSON.stringify({ id_token: 'SECRET', ok: 1 })}`,
      );
      expect(out).not.toContain('SECRET');
      expect(out).toContain('"ok": 1');
    },
  );

  it('redacts fragments and URL headers', () => {
    expect(net.redactUrl('http://x/cb#access_token=SECRET&state=1')).toBe(
      `http://x/cb#access_token=${net.REDACTED}&state=1`,
    );
    expect(net.redactUrl('http://x/a?code_verifier=S&x=1#frag')).toBe(
      `http://x/a?code_verifier=${net.REDACTED}&x=1#frag`,
    );
    const h = net.redactHeaders({
      Location: 'http://x/cb#access_token=SECRET',
      Referer: 'http://x/?token=SECRET',
      'Content-Location': '/a?api_key=SECRET',
      Refresh: '0; url=http://x/?id_token=SECRET',
    });
    expect(JSON.stringify(h)).not.toContain('SECRET');
  });

  it('widens request keys', () => {
    for (const k of ['code_verifier', 'client_assertion', 'assertion', 'device_code', 'signature'])
      expect(net.isSecretKey(k), k).toBe(true);
    expect(net.isSecretKey('code')).toBe(false);
    expect(
      net.redactRequestBody('code_verifier=S&code=1', 'application/x-www-form-urlencoded'),
    ).toBe(`code_verifier=${net.REDACTED}&code=1`);
  });

  it('redacts kebab-case keys', () => {
    const out = net.redactResponseBody('{"x-auth-token":"S","session-id":"S","ok":1}');
    expect(out).not.toContain('"S"');
  });

  it('redacts >8 KB form and multipart request bodies before truncating', async () => {
    await net.startRecording(1);
    const form = `password=SECRET1&token=SECRET2&filler=${'x'.repeat(9000)}`;
    request('f', 'http://x/', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: form,
    });
    const dash = 'Content-Disposition: form-data; name=';
    const mp = [
      `--B\r\n${dash}"password"\r\n\r\nSECRET3`,
      `--B\r\n${dash}"filler"\r\n\r\n${'x'.repeat(9000)}`,
      '--B--',
    ].join('\r\n');
    request('m', 'http://x/', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=B' },
      postData: mp,
    });
    for (const id of ['f', 'm']) {
      const e = net.getEntry(1, id);
      expect(e?.postDataTruncated, id).toBe(true);
      expect(e?.postData?.length).toBe(net.MAX_POST_DATA);
      expect(e?.postData, id).not.toContain('SECRET');
      expect(e?.postData, id).toContain(net.REDACTED);
    }
    expect(net.redactRequestBody(mp, 'multipart/form-data; boundary=B')).not.toContain('SECRET3');
  });

  it('multipart redaction is linear and bodies over 1 MB are dropped', async () => {
    const part = 'Content-Disposition: form-data; name="a"\r\n\r\nvalue\r\n';
    const big = Array.from({ length: 8000 }, () => `--B\r\n${part}`).join('') + '--B--';
    const s = t0();
    net.redactRequestBody(big, 'multipart/form-data; boundary=B');
    expect(t0() - s).toBeLessThan(500);
    await net.startRecording(1);
    request('huge', 'http://x/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      postData: `{"password":"SECRET","a":"${'x'.repeat(net.MAX_REDACT_INPUT)}"}`,
    });
    const e = net.getEntry(1, 'huge');
    expect(e?.postData).toBeUndefined();
    expect(e?.postDataNote).toBe('body too large to redact');
  });

  it('command exposes postDataTruncated and the truncation line', async () => {
    const { parseArgs } = await import('../../src/background/command');
    const { networkCommands } = await import('../../src/background/commands/network');
    const cmd = networkCommands[0];
    if (!cmd) throw new Error('missing');
    await net.startRecording(1);
    request('big', 'http://x/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      postData: JSON.stringify({ password: 'SECRET', filler: 'x'.repeat(9000) }),
    });
    const ctx = { tab: () => Promise.resolve(1) } as never;
    const r = (await cmd.run(ctx, parseArgs(['request', 'big'], cmd.flags ?? []))) as {
      text: string;
      data: Record<string, unknown>;
    };
    expect(r.data.postDataTruncated).toBe(true);
    expect(r.text).toContain(`[truncated at ${net.MAX_POST_DATA} characters]`);
    expect(r.text).not.toContain('SECRET');
  });

  it('JSON scanner is linear on escaped-quote inputs (closed and unclosed)', () => {
    const inputs = [
      `{"${'\\"'.repeat(40_000)}`,
      `{"${'\\"'.repeat(40_000)}"`,
      `["${'\\"a'.repeat(80_000)}"`,
      `["${'\\"a'.repeat(80_000)}`,
    ];
    for (const input of inputs) {
      const s0 = t0();
      net.redactResponseBody(input, 'application/javascript');
      net.redactRequestBody(input, 'application/x-ndjson');
      expect(t0() - s0).toBeLessThan(500);
    }
  });

  it('scanner redacts secret values with escapes and bare values', () => {
    const out = net.redactResponseBody(
      'x({"a":"q\\"uote","password":"S\\"1","token" : 12345,"ok":true});',
      'application/javascript',
    );
    expect(out).not.toContain('S\\"1');
    expect(out).not.toContain('12345');
    expect(out).toContain('"ok":true');
    expect(out).toContain('"a":"q\\"uote"');
  });

  it('withholds response bodies over the redaction limit', async () => {
    const send = mock.chrome.debugger.sendCommand as unknown as {
      mockImplementation(fn: (t: unknown, m: string) => unknown): void;
    };
    send.mockImplementation((_t, m) =>
      Promise.resolve(
        m === 'Network.getResponseBody'
          ? { body: 'x'.repeat(net.MAX_REDACT_INPUT + 1), base64Encoded: false }
          : {},
      ),
    );
    const r = await net.responseBody(1, {
      id: 'r',
      method: 'GET',
      url: 'u',
      type: 'Fetch',
      requestHeaders: {},
      responseHeaders: {},
      finished: true,
      status: 200,
      mimeType: 'text/plain',
    });
    expect(r.text).toBeUndefined();
    expect(r.note).toBe('body too large to redact');
  });

  it('redacts the :path pseudo-header from ExtraInfo events', async () => {
    await net.startRecording(1);
    fire('Network.requestWillBeSentExtraInfo', {
      requestId: 'p',
      headers: { ':path': '/api?access_token=SECRET&a=1', ':method': 'GET' },
    });
    const e = net.getEntry(1, 'p');
    expect(JSON.stringify(e)).not.toContain('SECRET');
    expect(e?.requestHeaders[':path']).toBe(`/api?access_token=${net.REDACTED}&a=1`);
  });

  it('notes a body Chrome dropped (hasPostData without postData)', async () => {
    await net.startRecording(1);
    request('d', 'http://x/', { method: 'POST', hasPostData: true });
    const e = net.getEntry(1, 'd');
    expect(e?.postData).toBeUndefined();
    expect(e?.postDataNote).toBe('body too large to redact');
  });

  it('multipart: unquoted names, filename is not a name, fail closed on mismatch', () => {
    const mp = '--B\r\nContent-Disposition: form-data; name=password\r\n\r\nSECRET\r\n--B--';
    expect(net.redactRequestBody(mp, 'multipart/form-data; boundary=B')).not.toContain('SECRET');
    const f =
      '--B\r\nContent-Disposition: form-data; name="f"; filename="token.txt"\r\n\r\nkeep\r\n--B--';
    expect(net.redactRequestBody(f, 'multipart/form-data; boundary=B')).toContain('keep');
    expect(net.redactRequestBody(mp, 'multipart/form-data; boundary=WRONG')).toBe(net.REDACTED);
  });

  it('redacts NDJSON / unparseable JSON request bodies', () => {
    const out = net.redactRequestBody(
      '{"password":"S1"}\n{"token":"S2","a":1}',
      'application/x-ndjson',
    );
    expect(out).not.toMatch(/S1|S2/);
    expect(out).toContain('"a":1');
    expect(net.redactRequestBody('{"password":"S1"} trailing', 'application/json')).not.toContain(
      'S1',
    );
  });

  it('redacts JWT-shaped and URL string values regardless of key', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig-nature_1';
    const out = JSON.parse(
      net.redactResponseBody(
        JSON.stringify({
          access: jwt,
          list: [jwt],
          url: 'https://s3.x/f?X-Amz-Signature=SECRET&id=1',
          note: 'see https://x/?token=SECRET',
        }),
      ),
    ) as Record<string, unknown>;
    expect(out.access).toBe(net.REDACTED);
    expect(out.list).toEqual([net.REDACTED]);
    expect(out.url).toBe(`https://s3.x/f?X-Amz-Signature=${net.REDACTED}&id=1`);
    const nd = net.redactResponseBody(
      `{"a":"${jwt}"}\n{"u":"https:\\/\\/x\\/?api_key=SECRET"}`,
      'application/x-ndjson',
    );
    expect(nd).not.toContain('eyJ');
    expect(nd).not.toContain('SECRET');
  });

  it('a stray quote does not shift pairing onto later lines', () => {
    const sse = net.redactResponseBody(
      'event: "x\ndata: {"token":"S1","ok":1}\n\n',
      'text/event-stream',
    );
    expect(sse).not.toContain('S1');
    expect(sse).toContain('"ok":1');
    const nd = net.redactResponseBody(
      '{"note":"it"s broken}\n{"password":"S2","a":1}\n',
      'application/x-ndjson',
    );
    expect(nd).not.toContain('S2');
    expect(nd).toContain('"a":1');
    const req = net.redactRequestBody('{"a":"x\n{"token":"S3"}', 'application/x-ndjson');
    expect(req).not.toContain('S3');
  });
});
