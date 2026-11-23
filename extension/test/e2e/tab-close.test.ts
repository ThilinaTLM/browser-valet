// Closing a tab the agent controls can make Chrome terminate the extension's service worker while
// the proxy still holds its socket (issue #51). Whether it does is a race inside Chrome, so these
// tests do not require either outcome. They require that bvl copes with both: `status` never says
// "connected" for a dead worker, and the next command succeeds (after waiting for the worker's
// 30 s alarm to restart it, if need be).

import { describe, expect, it } from 'vitest';
import {
  approveNextConsent,
  bvl,
  extensionWorkerRunning,
  fixture,
  openUserTab,
  tidForTitle,
  useBrowser,
  waitForExtension,
} from './harness';

useBrowser();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SLOW = 90_000; // a dead worker is restarted by its 30 s alarm at the latest

/** After the close: status agrees with reality, then a command works. */
async function expectRecovery(): Promise<void> {
  await sleep(1500); // let Chrome finish closing (and, perhaps, stop the worker)
  const running = await extensionWorkerRunning();
  const status = (await bvl('status')).stdout;
  if (!running) {
    expect(status, 'status must not report a dead worker as connected').toContain(
      'extension: not connected',
    );
  }
  const r = await bvl('open', fixture('/form.html'));
  expect(r.stderr.replace(/browser extension stopped responding.*\n/, '')).toBe('');
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('Fixture Form');
  await waitForExtension();
}

describe('closing a controlled tab', () => {
  it('a shared (user) tab, debugger attached', { timeout: SLOW }, async () => {
    const page = await openUserTab(fixture('/other.html'));
    const tid = await tidForTitle('Fixture Other');
    const pending = bvl('tab', tid);
    await approveNextConsent('allow');
    expect((await pending).code).toBe(0);
    expect((await bvl('get', 'text', 'h1')).code).toBe(0); // attaches the debugger

    await page.close();
    await expectRecovery();
  });

  it('an agent tab', { timeout: SLOW }, async () => {
    expect((await bvl('open', fixture('/other.html'))).code).toBe(0);
    const tid = /\[(t\d+)\] Fixture Other/.exec((await bvl('tab')).stdout)?.[1];
    expect(tid).toBeDefined();
    expect((await bvl('tab', 'close', tid ?? '')).code).toBe(0);
    await expectRecovery();
  });
});
