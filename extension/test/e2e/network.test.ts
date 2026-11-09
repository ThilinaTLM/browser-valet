// `network requests` / `network request <id>`: lazy recording, filters, redaction, bodies.

import { describe, expect, it } from 'vitest';
import { bctlWith, fixture, useBrowser } from './harness';

useBrowser();

const net = (...args: string[]) => bctlWith({ BCTL_SESSION: 'net' }, ...args);

const SECRETS = [
  'tok-SECRET-123',
  'SESSIONSECRET',
  'QUERYSECRET',
  'KEYSECRET',
  'BEARERSECRET',
  'PWSECRET',
  'CSSECRET',
  'FORMSECRET',
];

function idOf(out: string, re: RegExp): string {
  const line = out.split('\n').find((l) => re.test(l));
  const id = /^\[([^\]]+)\]/.exec(line ?? '')?.[1];
  if (!id) throw new Error(`No request matching ${re} in:\n${out}`);
  return id;
}

describe('network observation', () => {
  it('records lazily, lists, filters and redacts', async () => {
    expect((await net('open', fixture('/net.html'))).code).toBe(0);

    // First use starts recording; the page load is not captured (documented hint).
    const first = await net('network', 'requests');
    expect(first.code).toBe(0);
    expect(first.stderr).toContain('⚠ Recording started');
    expect(first.stdout).not.toContain('Recording started');

    expect((await net('click', '#go')).code).toBe(0);
    await net('wait', '500');

    const all = (await net('network', 'requests')).stdout;
    expect(all).toMatch(
      /\[[^\]]+\] GET .*\/api\/ok\?access_token=%5Bredacted%5D|access_token=\[redacted\]/,
    );
    expect(all).toContain('/api/missing (Fetch) 404');
    expect(all).toContain('POST');
    expect(all).toContain('(Fetch) 500');
    for (const s of SECRETS) expect(all).not.toContain(s);

    const errs = (await net('network', 'requests', '--status', '4xx')).stdout;
    expect(errs).toContain('/api/missing');
    expect(errs).not.toContain('(Fetch) 500');
    const range = (await net('network', 'requests', '--status', '400-599')).stdout;
    expect(range).toContain('/api/missing');
    expect(range).toContain('/api/boom');
    expect(range).not.toContain('/api/ok');
    expect((await net('network', 'requests', '--status', '500')).stdout).toContain('/api/boom');
    expect(
      (await net('network', 'requests', '--method', 'put')).stdout.trim().split('\n'),
    ).toHaveLength(1);
    expect(
      (await net('network', 'requests', '--filter', 'missing')).stdout.trim().split('\n'),
    ).toHaveLength(1);
    expect((await net('network', 'requests', '--type', 'document')).stdout.trim()).toBe(
      'No requests captured',
    );
    expect((await net('network', 'requests', '--status', 'abc')).stderr).toContain('--status');

    const json = JSON.parse((await net('network', 'requests', '--json')).stdout) as {
      data: { requests: { requestId: string; status: number }[] };
    };
    expect(json.data.requests.length).toBeGreaterThanOrEqual(4);
  });

  it('shows redacted headers, request body and response body for one request', async () => {
    const list = (await net('network', 'requests')).stdout;

    const boom = await net('network', 'request', idOf(list, /\/api\/boom/));
    expect(boom.code).toBe(0);
    expect(boom.stdout).toContain('POST');
    expect(boom.stdout).toMatch(/authorization: \[redacted\]/i);
    expect(boom.stdout).toContain('"user":"ada"');
    expect(boom.stdout).toContain('"password":"[redacted]"');
    expect(boom.stdout).toContain('"client_secret":"[redacted]"');
    expect(boom.stdout).toContain('"error": "boom"');
    expect(boom.stdout).toMatch(/set-cookie: \[redacted\]/i);
    for (const s of SECRETS) expect(boom.stdout).not.toContain(s);

    const ok = await net('network', 'request', idOf(list, /\/api\/ok\?/));
    expect(ok.stdout).toMatch(/x-api-key: \[redacted\]/i);
    expect(ok.stdout).toMatch(/x-trace: visible-trace/i);
    expect(ok.stdout).toContain('"access_token": "[redacted]"');
    expect(ok.stdout).toContain('"message": "hello"');
    for (const s of SECRETS) expect(ok.stdout).not.toContain(s);

    const form = await net('network', 'request', idOf(list, /PUT .*\/api\/ok/));
    expect(form.stdout).toContain('name=ada&password=[redacted]&q=1');

    const j = JSON.parse(
      (await net('network', 'request', idOf(list, /\/api\/missing/), '--json')).stdout,
    ) as {
      data: { status: number; body: string };
    };
    expect(j.data.status).toBe(404);
    expect(j.data.body).toContain('validation failed');

    const nope = await net('network', 'request', 'does-not-exist');
    expect(nope.code).toBe(1);
    expect(nope.stderr).toContain('Request not found');
  });

  it('--clear empties the log and recording continues', async () => {
    expect((await net('network', 'requests', '--clear')).stdout).toContain('cleared');
    expect((await net('network', 'requests')).stdout.trim()).toBe('No requests captured');
    await net('click', '#go');
    await net('wait', '500');
    expect((await net('network', 'requests', '--filter', 'api')).stdout).toContain('/api/missing');
  });
});
