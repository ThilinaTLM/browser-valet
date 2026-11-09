import { describe, expect, it } from 'vitest';
import { clickableScript, clickableSuffix, MAX_CLICKABLE } from '../../src/background/clickable';

describe('clickableSuffix', () => {
  it('says clickable for pointer or onclick, in the given order', () => {
    expect(clickableSuffix(['cursor:pointer'])).toBe('clickable [cursor:pointer]');
    expect(clickableSuffix(['cursor:pointer', 'onclick', 'tabindex'])).toBe(
      'clickable [cursor:pointer, onclick, tabindex]',
    );
    expect(clickableSuffix(['onclick', 'tabindex'])).toBe('clickable [onclick, tabindex]');
  });

  it('says focusable when tabindex is the only reason', () => {
    expect(clickableSuffix(['tabindex'])).toBe('focusable [tabindex]');
  });

  it('is empty without reasons', () => {
    expect(clickableSuffix([])).toBe('');
  });
});

describe('clickableScript', () => {
  it('is a self-contained expression with the cap, and text only when asked', () => {
    const withText = clickableScript(true);
    expect(withText).toContain(`els.length < ${String(MAX_CLICKABLE)}`);
    expect(withText).toContain('textContent');
    expect(clickableScript(false)).not.toContain('textContent');
  });
});
