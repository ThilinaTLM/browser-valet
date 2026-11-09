// Agent guardrails: output limit, content boundaries, allowed domains, confirmation.

import { afterEach, describe, expect, it } from 'vitest';
import { bctl, fixture, setGuardrails, useBrowser } from './harness';

useBrowser();

afterEach(async () => {
  await setGuardrails({});
});

describe('--max-output', () => {
  it('truncates text output with the upstream marker', async () => {
    await bctl('open', fixture('/prose.html'));
    const full = (await bctl('get', 'text', 'body')).stdout;
    expect(full.length).toBeGreaterThan(60);
    const r = await bctl('get', 'text', 'body', '--max-output', '40');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      `${full.trimEnd().slice(0, 40)}\n[truncated: showing 40 of ${full.trimEnd().length} chars. Use --max-output to adjust]\n`,
    );
  });

  it('accepts the flag before the command and marks --json with truncated: true', async () => {
    const r = await bctl('--max-output', '30', 'get', 'text', 'body', '--json');
    const j = JSON.parse(r.stdout) as {
      success: boolean;
      data: { text: string; truncated: boolean };
    };
    expect(j.success).toBe(true);
    expect(j.data.truncated).toBe(true);
    expect(j.data.text).toContain('[truncated: showing 30 of');
  });

  it('read uses the global flag', async () => {
    const r = await bctl('read', '--max-output', '25');
    expect(r.stdout).toContain('[truncated: showing 25 of ');
  });

  it('applies the popup default, and the flag overrides it', async () => {
    await setGuardrails({ maxOutput: 20 });
    const cut = await bctl('get', 'text', 'body');
    expect(cut.stdout).toContain('[truncated: showing 20 of ');
    const wide = await bctl('get', 'text', 'body', '--max-output', '100000');
    expect(wide.stdout).not.toContain('[truncated');
  });

  it('rejects a bad value', async () => {
    const r = await bctl('get', 'text', 'body', '--max-output', '0', '--json');
    expect(JSON.parse(r.stdout)).toMatchObject({ success: false, code: 'bad_args' });
  });
});
