import { describe, expect, it } from 'vitest';
import {
  navData,
  navFailure,
  navTimeout,
  navWarnings,
  titleLine,
} from '../../src/background/nav-outcome';

describe('nav outcome', () => {
  it('prints (no title) for empty titles', () => {
    expect(titleLine('')).toBe('✓ (no title)');
    expect(titleLine('  ')).toBe('✓ (no title)');
    expect(titleLine('Hi')).toBe('✓ Hi');
  });
  it('warns when still loading or HTTP error', () => {
    expect(navWarnings({ loaded: true }, 'u', 1000)).toEqual([]);
    expect(navWarnings({ loaded: false }, 'u', 1000)[0]).toBe(
      'Page still loading after 1000 ms; continuing (use wait --load or wait --text)',
    );
    expect(navWarnings({ loaded: true, status: 404 }, 'http://x/', 1000)).toEqual([
      'HTTP 404 from http://x/',
    ]);
    expect(navWarnings({ loaded: true, status: 200 }, 'u', 1000)).toEqual([]);
  });
  it('keeps json additive', () => {
    expect(navData({ loaded: true })).toEqual({});
    expect(navData({ loaded: false, status: 503 })).toEqual({ loaded: false, status: 503 });
  });
  it('codes failures', () => {
    const e = navFailure('https://not-a-valid-url', 'net::ERR_NAME_NOT_RESOLVED');
    expect(e.code).toBe('navigation_failed');
    expect(e.message).toBe('Could not resolve host "not-a-valid-url"');
    const h = navFailure('http://x/', 'net::ERR_HTTP_RESPONSE_CODE_FAILURE', 404);
    expect(h.message).toContain('(HTTP 404)');
    expect(navTimeout('http://x/', 1000).code).toBe('timeout');
  });
});
