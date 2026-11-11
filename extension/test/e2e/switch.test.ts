// The on/off switch follows bvl: stopping bvl switches the extension off until the user switches it
// on again; an announced restart (re-pairing) keeps it on. Every test leaves the extension on.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { bvl, bvlWith, popupView, setSwitch, useBrowser, waitForExtension } from './harness';

useBrowser();

afterAll(async () => {
  await setSwitch(true);
  await waitForExtension();
});

describe('on/off switch', () => {
  it('bvl stop switches the extension off, and agents are told to ask the user', async () => {
    await waitForExtension();
    expect((await bvl('stop')).stdout).toContain('Proxy stopped');

    await expect.poll(async () => (await popupView()).checked, { timeout: 10_000 }).toBe(false);
    const view = await popupView();
    expect(view.status).toBe('Off');
    expect(view.text).toContain('bvl was stopped');

    // A new proxy starts, but the extension stays off. The proxy reads BVL_EXT_WAIT_MS when it
    // starts, so set it on the command that starts it (otherwise `get title` waits the full 10 s).
    const status = await bvlWith({ BVL_EXT_WAIT_MS: '1500' }, 'status');
    expect(status.stdout).toContain('extension: not connected');
    expect(status.stdout).toContain('switch it on');
    const cmd = await bvlWith({ BVL_EXT_WAIT_MS: '1500' }, 'get', 'title');
    expect(cmd.code).toBe(1);
    expect(cmd.stderr).toContain('switch it on');

    await setSwitch(true);
    await waitForExtension();
    expect((await popupView()).text).not.toContain('Switched off');
  });

  it('re-pairing restarts the proxy and keeps the extension on', async () => {
    await waitForExtension();
    const env = inject('e2e').env;
    const config = JSON.parse(
      readFileSync(join(env.BVL_CONFIG_DIR ?? '', 'config.json'), 'utf8'),
    ) as { secret: string; port: number };
    expect((await bvl('pair', config.secret, '--port', String(config.port))).code).toBe(0);
    await waitForExtension();
    expect((await popupView()).checked).toBe(true);
  });
});
