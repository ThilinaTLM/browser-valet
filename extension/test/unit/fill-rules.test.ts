import { describe, expect, it } from 'vitest';
import { fillProblem } from '../../src/background/commands/fill-rules';

describe('fillProblem', () => {
  it('accepts an exact match and an empty fill', () => {
    expect(fillProblem('text', 'abc', 'abc')).toBeUndefined();
    expect(fillProblem('time', '', '')).toBeUndefined();
  });

  it('fails with a format hint when a date-like input stayed empty', () => {
    expect(fillProblem('time', '10:30pm', '')).toEqual({
      fail: true,
      message: 'fill did not stick: value is "" (input type=time expects HH:MM)',
    });
    expect(fillProblem('date', 'tomorrow', '')?.message).toContain('YYYY-MM-DD');
  });

  it('fails for a plain text input that stayed empty', () => {
    expect(fillProblem('text', 'x', '')).toEqual({
      fail: true,
      message:
        'fill did not stick: value is "" (the page may have reset the field, e.g. while it was still loading; retry, or wait for the page first)',
    });
  });

  it('only warns when the field reformatted the text', () => {
    expect(fillProblem('text', 'abcdef', 'abc')).toMatchObject({ fail: false });
    expect(fillProblem('range', '500', '100')).toMatchObject({ fail: false });
  });

  it('treats equivalent values as success', () => {
    expect(fillProblem('number', '1e3', '1000')).toBeUndefined();
    expect(fillProblem('color', '#FF0000', '#ff0000')).toBeUndefined();
    expect(fillProblem('textarea', 'a\r\nb', 'a\nb')).toBeUndefined();
  });

  it('does not echo password values', () => {
    expect(fillProblem('password', 'secret', 'sec')?.message).not.toContain('sec"');
  });
});
