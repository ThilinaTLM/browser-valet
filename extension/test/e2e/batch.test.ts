// `batch`: several commands in one call.

import { describe, expect, it } from 'vitest';
import { bvl, bvlStdin, fixture, useBrowser } from './harness';

useBrowser();

interface Item {
  command?: string[];
  index?: number;
  success: boolean;
  result: unknown;
  error: string | null;
}

describe('batch', () => {
  it('runs a fill / click / wait / read sequence in one call', async () => {
    expect((await bvl('open', fixture('/form.html'))).code).toBe(0);
    const r = await bvl(
      'batch',
      'fill #name "Ada Lovelace"',
      'click #inc',
      'wait --text "Count: 1"',
      'get text #echo',
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('✓ Done\n\n✓ Done\n\nCount: 1\n\nHello, Ada Lovelace!\n');
  });

  it('continues after a failure and exits 1; --bail stops', async () => {
    await bvl('open', fixture('/form.html'));
    const all = await bvl('batch', 'click #nope --timeout 300', 'get title');
    expect(all.code).toBe(1);
    expect(all.stderr).toMatch(/^✗ /);
    expect(all.stdout).toContain('Fixture Form');

    const bail = await bvl('batch', '--bail', 'click #nope --timeout 300', 'get title');
    expect(bail.code).toBe(1);
    expect(bail.stdout).not.toContain('Fixture Form');
  });

  it('--stdin reads one command per line', async () => {
    const r = await bvlStdin(
      `open ${fixture('/form.html')}\n\nfill #name 'Grace Hopper'\nget text #echo\n`,
      'batch',
      '--stdin',
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Hello, Grace Hopper!');
  });

  it('--json is a top-level array with upstream keys; --omit-command uses index', async () => {
    await bvl('open', fixture('/form.html'));
    const r = await bvl('batch', '--json', 'get title', 'click #nope --timeout 300');
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as Item[];
    expect(out[0]).toMatchObject({
      command: ['get', 'title'],
      success: true,
      result: { title: 'Fixture Form' },
      error: null,
    });
    expect(out[1]).toMatchObject({
      command: ['click', '#nope', '--timeout', '300'],
      success: false,
      result: null,
    });
    expect(out[1]?.error).toMatch(/not found|No element/i);

    const o = JSON.parse(
      (await bvl('batch', '--json', '--omit-command', 'get title')).stdout,
    ) as Item[];
    expect(o).toEqual([
      { index: 0, success: true, result: { title: 'Fixture Form' }, error: null },
    ]);
  });

  it('rejects nested batch, per-item --session and eval --stdin', async () => {
    const r = await bvl(
      'batch',
      '--json',
      'batch "get title"',
      'get title --session x',
      'eval --stdin',
    );
    const out = JSON.parse(r.stdout) as Item[];
    expect(r.code).toBe(1);
    expect(out.map((i) => i.success)).toEqual([false, false, false]);
  });

  it('a confirm dialog ends the batch', async () => {
    await bvl('open', fixture('/dialog.html'));
    const r = await bvl('batch', '--json', 'click #ask', 'get title');
    const out = JSON.parse(r.stdout) as Item[];
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      success: true,
      result: { dialog: { type: 'confirm', message: 'Really?' } },
    });
    expect(r.stderr).toContain('⚠ A JavaScript confirm dialog');
    expect((await bvl('dialog', 'dismiss')).code).toBe(0);
  });

  it('--timeout applies per item', async () => {
    await bvl('open', fixture('/form.html'));
    const r = await bvl('batch', '--timeout', '500', 'wait #never1', 'wait #never2', '--json');
    const out = JSON.parse(r.stdout) as Item[];
    expect(out.map((i) => i.success)).toEqual([false, false]);
  });

  it('merges files from several items', async () => {
    await bvl('open', fixture('/form.html'));
    const r = await bvl('batch', 'screenshot batch-a.png', 'screenshot batch-b.png');
    expect(r.code).toBe(0);
    const fs = await import('node:fs');
    const { workDir } = await import('./harness');
    expect(fs.existsSync(`${workDir()}/batch-a.png`)).toBe(true);
    expect(fs.existsSync(`${workDir()}/batch-b.png`)).toBe(true);
  });
});
