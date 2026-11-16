// Actionability of clicks: overlays that only go away on the next frame of a hidden tab, partly
// covered targets, and the combobox fill hint.

import { afterAll, describe, expect, it } from 'vitest';
import { bvl, fixture, useBrowser } from './harness';

useBrowser();

const S = ['--session', 'covered-e2e'];

interface Json {
  success: boolean;
  error?: string;
  code?: string;
}
const json = async (...args: string[]) =>
  JSON.parse((await bvl(...args, ...S, '--json')).stdout) as Json;

afterAll(async () => {
  await bvl('close', ...S);
});

const out = async () => (await bvl('get', 'text', '#out', ...S)).stdout.trim();

describe('covered check', () => {
  it('forces a frame before blaming an overlay the page removes on its next frame', async () => {
    await bvl('open', fixture('/covered.html'), ...S);
    expect((await bvl('eval', 'document.visibilityState', ...S)).stdout.trim()).toBe('"hidden"');
    expect((await bvl('click', '#busy', ...S)).code).toBe(0);
    expect((await bvl('check', '#agree', ...S)).code).toBe(0);
    expect(await out()).toBe('busy;agree;');
  });

  it('wait --state hidden sees an overlay removed in requestAnimationFrame', async () => {
    await bvl('open', fixture('/covered.html'), ...S);
    await bvl('click', '#busy', ...S);
    const r = await bvl('wait', '#spinner', '--state', 'hidden', '--timeout', '5000', ...S);
    expect(r.code).toBe(0);
  });

  it('clicks the visible part of a partly covered element', async () => {
    await bvl('open', fixture('/covered.html'), ...S);
    expect((await bvl('click', '#partial-btn', ...S)).code).toBe(0);
    expect(await out()).toBe('partial-btn;');
  });

  it('treats content slotted into a shadow-DOM button as the button', async () => {
    await bvl('open', fixture('/covered.html'), ...S);
    const snap = (await bvl('snapshot', '-i', ...S)).stdout;
    const ref = /button "Submit" \[ref=(e\d+)\]/.exec(snap)?.[1];
    expect(ref, snap).toBeDefined();
    const r = await bvl('click', `@${ref ?? ''}`, ...S);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(await out()).toBe('shadow;');
  });

  it('still refuses a fully covered element and names both', async () => {
    await bvl('open', fixture('/covered.html'), ...S);
    const r = await json('click', '#hidden-btn');
    expect(r).toMatchObject({ success: false, code: 'covered' });
    expect(r.error).toContain('<button#hidden-btn> is covered by <span.over>');
    expect(await out()).toBe('(empty)');
  });
});

describe('fill on a combobox', () => {
  it('succeeds but warns that the choice may have to come from the list', async () => {
    await bvl('open', fixture('/covered.html'), ...S);
    const r = await bvl('fill', '#combo', 'October', ...S);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('combobox');
    expect((await bvl('fill', '#plain', 'x', ...S)).stderr).toBe('');
  });
});
