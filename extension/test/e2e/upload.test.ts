// `upload` on a button that makes the browser open a file chooser.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bvl, fixture, useBrowser, workDir } from './harness';

useBrowser();

const jsonOf = (out: string): unknown => JSON.parse(out);

const S = ['--session', 'upload-e2e'];

afterAll(async () => {
  await bvl('close', ...S);
});

describe('upload through a file chooser', () => {
  it('fulfils the chooser a button opens', async () => {
    await bvl('open', fixture('/upload-dynamic.html'), ...S);
    await writeFile(join(workDir(), 'cv.txt'), 'hello');
    const r = await bvl('upload', '#up', 'cv.txt', ...S);
    const vis = (await bvl('eval', 'document.visibilityState', ...S)).stdout;
    expect(r.code, `${r.stderr} vis=${vis}`).toBe(0);
    expect((await bvl('get', 'text', '#name', ...S)).stdout.trim()).toBe('cv.txt');
  });

  it('rejects several files for a single-file chooser', async () => {
    await bvl('open', fixture('/upload-dynamic.html'), ...S);
    await writeFile(join(workDir(), 'a.txt'), 'a');
    await writeFile(join(workDir(), 'b.txt'), 'b');
    const r = await bvl('upload', '#single', 'a.txt', 'b.txt', ...S, '--json');
    expect(jsonOf(r.stdout)).toMatchObject({ success: false, code: 'bad_args' });
  });

  it('times out when no chooser opens', async () => {
    await bvl('open', fixture('/upload-dynamic.html'), ...S);
    await writeFile(join(workDir(), 'cv.txt'), 'hello');
    const r = await bvl('upload', '#nothing', 'cv.txt', ...S, '--timeout', '1500', '--json');
    const j = jsonOf(r.stdout) as { success: boolean; code?: string; error?: string };
    expect(j).toMatchObject({ success: false, code: 'timeout' });
    expect(j.error).toContain('showOpenFilePicker');
  });
});

describe('upload of a missing file', () => {
  it('fails before touching the page, and still accepts an empty file', async () => {
    await bvl('open', fixture('/upload.html'), ...S);
    const r = await bvl('upload', '#f', 'does-not-exist.pdf', ...S, '--json');
    const j = jsonOf(r.stdout) as { success: boolean; code?: string; error?: string };
    expect(j).toMatchObject({ success: false, code: 'bad_args' });
    expect(j.error).toContain('does-not-exist.pdf');
    expect((await bvl('get', 'text', '#name', ...S)).stdout.trim()).toBe('(empty)');
    await writeFile(join(workDir(), 'empty.txt'), '');
    expect((await bvl('upload', '#f', 'empty.txt', ...S)).code).toBe(0);
    expect((await bvl('get', 'text', '#name', ...S)).stdout.trim()).toBe('empty.txt');
  });
});
