// Helpers for E2E test files. See docs/architecture/development.md ("Testing").
//
//   import { bctl, approveNextConsent, openUserTab, fixture, useBrowser } from './harness';
//
//   const browser = useBrowser();            // connects in beforeAll, disconnects in afterAll
//   it('...', async () => {
//     const r = await bctl('open', fixture('/form.html'));
//     expect(r.code).toBe(0);
//   });
//
// All bctl subprocesses run against the temp config dir and non-default port created by
// global-setup.ts, never against the developer's real bctl or browser.

import { spawn } from 'node:child_process';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, inject } from 'vitest';

export interface BctlResult {
  code: number;
  stdout: string;
  stderr: string;
}

const info = () => inject('e2e');

/** URL of a fixture page (files live in test/e2e/fixtures/). */
export const fixture = (path = '/'): string => `${info().fixtureUrl}${path}`;

/** URL of a fixture page under another site (`localhost`; the host page uses 127.0.0.1). */
export const crossFixture = (path = '/'): string => `${info().crossFixtureUrl}${path}`;

/** The frames host page with the inner page from the other site: an out-of-process iframe. */
export const framesPage = (query = '', innerQuery = ''): string =>
  `${fixture('/frames.html')}?inner=${encodeURIComponent(crossFixture(`/frame-inner.html${innerQuery}`))}${query}`;

/** Scratch directory used as the cwd of every bctl run (for screenshots and the like). */
export const workDir = (): string => info().workDir;

/** Run `bctl <args>` and collect its output. Never rejects; check `code`. */
export function bctl(...args: string[]): Promise<BctlResult> {
  return bctlWith({}, ...args);
}

/** Like `bctl` with extra environment variables (e.g. `{ BCTL_SESSION: 'other' }`). */
export function bctlWith(env: Record<string, string>, ...args: string[]): Promise<BctlResult> {
  return run(env, undefined, args);
}

/** `bctl <args>` with `stdin` piped in (for `--stdin` commands). */
export function bctlStdin(stdin: string, ...args: string[]): Promise<BctlResult> {
  return run({}, stdin, args);
}

function run(
  env: Record<string, string>,
  stdin: string | undefined,
  args: string[],
): Promise<BctlResult> {
  const { bin, env: base, workDir: cwd } = info();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: { ...base, ...env }, cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.once('error', reject);
    child.stdin.end(stdin ?? '');
    child.once('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** `bctl --json …`, parsed: `{ success, data, error }`. */
export async function bctlJson(
  ...args: string[]
): Promise<{ success: boolean; data: unknown; error: string | null }> {
  const r = await bctl(...args, '--json');
  return JSON.parse(r.stdout) as { success: boolean; data: unknown; error: string | null };
}

let shared: Browser | undefined;

/** Connect to the shared browser for this test file. Call at describe level. */
export function useBrowser(): { readonly current: Browser } {
  beforeAll(async () => {
    shared = await puppeteer.connect({
      browserWSEndpoint: info().wsEndpoint,
      // No viewport emulation: puppeteer would override the page size bctl sets.
      defaultViewport: null,
    });
  });
  afterAll(async () => {
    await shared?.disconnect();
    shared = undefined;
  });
  return {
    get current() {
      if (!shared) throw new Error('useBrowser(): browser not connected yet');
      return shared;
    },
  };
}

function browser(): Browser {
  if (!shared) throw new Error('Call useBrowser() in the test file first');
  return shared;
}

/**
 * Open a page as the *user* would (a tab the agent has no access to until approved).
 *
 * The extension treats a tab opened by a controlled tab as the agent's, and Chrome gives
 * `newPage()` the *active* tab as opener. Earlier files leave agent tabs behind (some blank, e.g.
 * after a refused navigation), so "activate an about:blank tab first" could pick one of those and
 * turn the user tab into an agent tab. A target created in a new window has no opener at all.
 */
export async function openUserTab(url: string): Promise<Page> {
  const session = await browser().target().createCDPSession();
  let page: Page | null;
  try {
    const { targetId } = await session.send('Target.createTarget', {
      url: 'about:blank',
      newWindow: true,
    });
    const target = await browser().waitForTarget(
      (t) => (t as unknown as { _targetId: string })._targetId === targetId,
    );
    page = await target.page();
  } finally {
    await session.detach().catch(() => undefined);
  }
  if (!page) throw new Error('could not open a user tab');
  await page.goto(url);
  return page;
}

/** Find the `tN` id that `bctl tab` shows for a page title (optionally only unshared tabs). */
export async function tidForTitle(title: string): Promise<string> {
  const r = await bctl('tab', '--json');
  const tabs = (JSON.parse(r.stdout) as { data: { tabs: { tabId: string; title: string }[] } }).data
    .tabs;
  const hit = tabs.find((t) => t.title === title);
  if (!hit) throw new Error(`No tab titled "${title}" in: ${r.stdout}`);
  return hit.tabId;
}

/**
 * Open the extension popup in a page, wait for a pending permission request, and click
 * Allow (default) or Deny. Start the consenting command first (do not await it), then call this,
 * then await the command:
 *
 *   const pending = bctl('tab', tid);
 *   await approveNextConsent();           // or approveNextConsent('deny')
 *   expect((await pending).code).toBe(0);
 */
export async function approveNextConsent(decision: 'allow' | 'deny' = 'allow'): Promise<string> {
  const page = await browser().newPage();
  try {
    await page.goto(`${info().extensionOrigin}/popup.html?window=1`);
    const button = await page.waitForSelector(`button[data-action="${decision}"]`, {
      timeout: 30_000,
    });
    // The text of the card being decided (what the user sees), for tests that check redaction.
    const card = await page.evaluate(
      () => document.querySelector('.card.alert')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
    );
    await button?.click();
    // The popup window closes itself once no request is pending; wait for that (or the button
    // to vanish) so the decision has been delivered before we return.
    await page
      .waitForSelector(`button[data-action="${decision}"]`, { hidden: true, timeout: 15_000 })
      .catch(() => undefined); // page closed itself (or the command result will show the failure)
    return card;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Click the popup's "Stop" button for the agent tab `tid` (e.g. "t2"). */
export async function stopTabInPopup(tid: string): Promise<void> {
  const page = await browser().newPage();
  try {
    await page.goto(`${info().extensionOrigin}/popup.html`);
    const handle = await page.waitForFunction(
      (id: string) => {
        for (const row of document.querySelectorAll('.tab')) {
          if (row.querySelector('.tid')?.textContent.trim().split(' ')[0] === id) {
            return row.querySelector('button[data-action="revoke"]') ?? false;
          }
        }
        return false;
      },
      { timeout: 15_000 },
      tid,
    );
    await (handle.asElement() as unknown as { click(): Promise<void> }).click();
    await page.waitForFunction(
      (id: string) =>
        ![...document.querySelectorAll('.tab .tid')].some(
          (e) => e.textContent.trim().split(' ')[0] === id,
        ),
      { timeout: 15_000 },
      tid,
    );
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * Kill the extension's service worker, as Chrome does when it is idle, and wake it again.
 * The debugger attachments and `chrome.storage.session` survive; in-memory state does not.
 */
export async function restartExtensionWorker(): Promise<void> {
  const session = await browser().target().createCDPSession();
  try {
    const { targetInfos } = await session.send('Target.getTargets');
    const sw = targetInfos.find(
      (t) => t.type === 'service_worker' && t.url.startsWith(info().extensionOrigin),
    );
    if (!sw) throw new Error('extension service worker not found');
    await session.send('Target.closeTarget', { targetId: sw.targetId });
  } finally {
    await session.detach().catch(() => undefined);
  }
  // Let the proxy notice the disconnect, so that "connected" below means the new worker.
  for (let i = 0; i < 20; i++) {
    if ((await bctl('status')).stdout.includes('extension: not connected')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Opening an extension page starts the worker again; it reconnects to the proxy by itself.
  const page = await browser().newPage();
  try {
    await page.goto(`${info().extensionOrigin}/popup.html?window=1`);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const r = await bctl('status');
      if (/extension: \S/.test(r.stdout) && !r.stdout.includes('extension: not connected')) break;
      if (Date.now() > deadline) throw new Error(`extension did not reconnect:\n${r.stdout}`);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * Set the user's guardrail policy the way the popup does (a `guardrails` message to the worker).
 * Pass `{}` to reset to the defaults. Always reset in `afterEach`/`afterAll`: the policy is
 * persistent browser state shared by every test file in the run.
 */
export async function setGuardrails(patch: Record<string, unknown>): Promise<void> {
  const page = await browser().newPage();
  try {
    await page.goto(`${info().extensionOrigin}/popup.html`);
    const reply = await page.evaluate(async (p: Record<string, unknown>) => {
      const res: unknown = await chrome.runtime.sendMessage({
        type: 'guardrails',
        guardrails: {
          maxOutput: 0,
          contentBoundaries: false,
          allowedDomains: [],
          confirm: [],
          ...p,
        },
      });
      return res;
    }, patch);
    const r = reply as { ok: boolean; error?: string };
    if (!r.ok) throw new Error(`guardrails update failed: ${r.error ?? ''}`);
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * Open `url` in a new tab the way a popup is created: Chrome gives a tab opened while another is
 * active that tab as its opener, so activate the tab showing `openerUrlPart` first. The caller
 * closes the returned page.
 */
export async function openFromTab(openerUrlPart: string, url: string): Promise<Page> {
  const opener = (await browser().pages()).find((p) => p.url().includes(openerUrlPart));
  if (!opener) throw new Error(`no tab showing ${openerUrlPart}`);
  await opener.bringToFront();
  const page = await browser().newPage();
  void page.goto(url).catch(() => undefined); // may be blocked on purpose
  return page;
}
