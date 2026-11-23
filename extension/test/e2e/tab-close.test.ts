// Closing a tab the agent controls can leave Chrome's extension service worker wedged (JavaScript
// runs, every extension API call hangs) and then terminated, while the proxy still holds its socket
// (issue #51). Whether that happens is a race inside Chrome, so these tests do not require it. They
// require that bvl copes with every outcome: `status` never says "connected" for a worker that is
// dead or wedged, and the next command succeeds (after waiting for the worker to restart, if need
// be). Each test logs which path it took and how long recovery took.

import { describe, expect, it } from 'vitest';
import {
  approveNextConsent,
  bvl,
  extensionWorkerState,
  fixture,
  openUserTab,
  tidForTitle,
  useBrowser,
  waitForExtension,
} from './harness';

useBrowser();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wedged (up to ~30 s) plus the 30 s alarm; the proxy waits up to 65 s. */
const SLOW = 150_000;
const MAX_RECOVERY_MS = 70_000;

/**
 * After a tab was closed at `closedAt`: with `settle`, wait 1.5 s and check that `status` agrees with the
 * worker's real state; without it, run the next command at once (the case a script `close && next` hits).
 * Then the command must work.
 */
async function expectRecovery(name: string, closedAt: number, settle: boolean): Promise<void> {
  let path = 'not inspected';
  if (settle) {
    await sleep(1500); // let Chrome finish closing (and, perhaps, wedge or stop the worker)
    // Status first: inspecting attaches DevTools to the worker, which can change what it answers (a
    // run saw `status` connected right after a "wedged" reading). Wedging only ever progresses to
    // dead within these seconds, so a status taken before the reading must already agree with it.
    const status = (await bvl('status')).stdout;
    const state = await extensionWorkerState();
    path = state;
    if (state !== 'healthy') {
      expect(status, `status must not report a ${state} worker as connected`).toContain(
        'extension: not connected',
      );
    }
  }
  const r = await bvl('open', fixture('/form.html'));
  const took = Date.now() - closedAt;
  console.info(
    `[e2e] ${name}: worker ${path}; next command done ${String(took)} ms after the close`,
  );
  expect(r.stderr.replace(/browser extension stopped responding.*\n/, '')).toBe('');
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('Fixture Form');
  expect(took).toBeLessThan(MAX_RECOVERY_MS);
  await waitForExtension();
}

async function shareAndAttach(): Promise<Awaited<ReturnType<typeof openUserTab>>> {
  const page = await openUserTab(fixture('/other.html'));
  const tid = await tidForTitle('Fixture Other');
  const pending = bvl('tab', tid);
  await approveNextConsent('allow');
  expect((await pending).code).toBe(0);
  expect((await bvl('get', 'text', 'h1')).code).toBe(0); // attaches the debugger
  return page;
}

async function openAgentTab(): Promise<string> {
  expect((await bvl('open', fixture('/other.html'))).code).toBe(0);
  const tid = /\[(t\d+)\] Fixture Other/.exec((await bvl('tab')).stdout)?.[1];
  expect(tid).toBeDefined();
  return tid ?? '';
}

describe('closing a controlled tab', () => {
  it('a shared (user) tab, debugger attached', { timeout: SLOW }, async () => {
    const page = await shareAndAttach();
    await page.close();
    await expectRecovery('shared tab', Date.now(), true);
  });

  it('an agent tab', { timeout: SLOW }, async () => {
    const tid = await openAgentTab();
    expect((await bvl('tab', 'close', tid)).code).toBe(0);
    await expectRecovery('agent tab', Date.now(), true);
  });

  it('a shared tab, next command with no pause', { timeout: SLOW }, async () => {
    const page = await shareAndAttach();
    await page.close();
    await expectRecovery('shared tab, no pause', Date.now(), false);
  });

  it(
    'an agent tab closed by `tab close`, next command with no pause',
    { timeout: SLOW },
    async () => {
      const tid = await openAgentTab();
      expect((await bvl('tab', 'close', tid)).code).toBe(0);
      await expectRecovery('tab close, no pause', Date.now(), false);
    },
  );
});
