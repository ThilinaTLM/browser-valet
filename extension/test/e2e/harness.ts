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

/** Scratch directory used as the cwd of every bctl run (for screenshots and the like). */
export const workDir = (): string => info().workDir;

/** Run `bctl <args>` and collect its output. Never rejects; check `code`. */
export function bctl(...args: string[]): Promise<BctlResult> {
  return bctlWith({}, ...args);
}

/** Like `bctl` with extra environment variables (e.g. `{ BCTL_SESSION: 'other' }`). */
export function bctlWith(env: Record<string, string>, ...args: string[]): Promise<BctlResult> {
  const { bin, env: base, workDir: cwd } = info();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: { ...base, ...env }, cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.once('error', reject);
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
    shared = await puppeteer.connect({ browserWSEndpoint: info().wsEndpoint });
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

/** Open a page as the *user* would (a tab the agent has no access to until approved). */
export async function openUserTab(url: string): Promise<Page> {
  const page = await browser().newPage();
  await page.goto(url);
  return page;
}

/** Find the `tN` id that `bctl tab` shows for a page title (optionally only unshared tabs). */
export async function tidForTitle(title: string): Promise<string> {
  const r = await bctl('tab', '--json');
  const tabs = (JSON.parse(r.stdout) as { data: { tabId: string; title: string }[] }).data;
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
export async function approveNextConsent(decision: 'allow' | 'deny' = 'allow'): Promise<void> {
  const page = await browser().newPage();
  try {
    await page.goto(`${info().extensionOrigin}/popup.html?window=1`);
    const button = await page.waitForSelector(`button[data-action="${decision}"]`, {
      timeout: 30_000,
    });
    await button?.click();
    // The popup window closes itself once no request is pending; wait for that (or the button
    // to vanish) so the decision has been delivered before we return.
    await page
      .waitForSelector(`button[data-action="${decision}"]`, { hidden: true, timeout: 15_000 })
      .catch(() => undefined); // page closed itself (or the command result will show the failure)
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
