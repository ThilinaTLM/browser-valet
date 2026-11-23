import { describe, expect, it } from 'vitest';
import { splitScreenshotArgs } from '../../src/background/screenshot-args';

describe('splitScreenshotArgs', () => {
  it('has neither without positionals', () => {
    expect(splitScreenshotArgs([])).toEqual({});
  });
  it.each([
    'out.png',
    'out.JPG',
    'a.jpeg',
    'x.webp',
    '/tmp/shot',
    './out',
    '../out',
    'dir/out',
    '~/x',
    '//h1',
    'C:\\x\\y',
    'C:/x',
    'OUT.PNG',
    'my dir/shot',
    '\\x',
    '/tmp/shot (1)/x',
    'sub/dir',
  ])('one positional %s is a path', (p) => {
    expect(splitScreenshotArgs([p])).toEqual({ path: p });
  });
  it.each([
    'h1',
    '#id',
    '.card',
    '@e3',
    'a.txt',
    'div > p',
    'a[href="/x"]',
    '(//h1)[1]',
    'text=Hi',
    '.shots/a.png',
    '#a/b',
    '@e3.png',
    'out',
    'div > a/b',
  ])('one positional %s is a target', (t) => {
    expect(splitScreenshotArgs([t])).toEqual({ target: t });
  });
  it('two positionals are target then path', () => {
    expect(splitScreenshotArgs(['//h1', 'o'])).toEqual({ target: '//h1', path: 'o' });
    expect(splitScreenshotArgs(['@e3', 'out.png'])).toEqual({ target: '@e3', path: 'out.png' });
  });
});
