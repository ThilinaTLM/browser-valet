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
    expect(r.code).toBe(0);
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
