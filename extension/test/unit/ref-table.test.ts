import { describe, expect, it } from 'vitest';
import { RefTable } from '../../src/background/ref-table';

describe('RefTable', () => {
  it('numbers new nodes from the counter in assignment order', () => {
    const t = new RefTable(undefined, 1);
    expect(t.assign(10, 'button', 'A')).toBe('e1');
    expect(t.assign(20, 'link', 'B')).toBe('e2');
    expect(t.counter).toBe(3);
    expect(t.seen).toEqual({ e1: { role: 'button', name: 'A' }, e2: { role: 'link', name: 'B' } });
  });

  it('gives a known node its old ref and refreshes role and name', () => {
    const first = new RefTable(undefined, 1);
    first.assign(10, 'button', 'A');
    first.assign(20, 'link', 'B');
    const second = new RefTable(first.refs, first.counter);
    expect(second.assign(20, 'link', 'B2')).toBe('e2');
    expect(second.assign(30, 'button', 'C')).toBe('e3');
    expect(second.assign(10, 'button', 'A')).toBe('e1');
    expect(second.refs.e2).toEqual({ backendNodeId: 20, role: 'link', name: 'B2' });
  });

  it('does not mutate the previous refs', () => {
    const prev = { e1: { backendNodeId: 1, role: 'button', name: 'A' } };
    const t = new RefTable(prev, 2);
    t.assign(1, 'button', 'Renamed');
    t.assign(2, 'link', 'New');
    expect(prev).toEqual({ e1: { backendNodeId: 1, role: 'button', name: 'A' } });
  });

  it('keeps counting above the counter after the refs were cleared (navigation)', () => {
    const before = new RefTable(undefined, 1);
    before.assign(1, 'button', 'A');
    before.assign(2, 'button', 'B');
    const after = new RefTable(undefined, before.counter);
    expect(after.assign(1, 'button', 'A')).toBe('e3'); // same backend id, new document: new ref
  });

  it('raises the counter above refs another session assigned in the same tab', () => {
    const prev = { e7: { backendNodeId: 1, role: 'button', name: 'A' } };
    const t = new RefTable(prev, 2);
    expect(t.assign(99, 'link', 'B')).toBe('e8');
  });

  it('prune drops refs whose node is gone and reports them sorted by number', () => {
    const t = new RefTable(undefined, 1);
    for (let i = 1; i <= 11; i++) t.assign(i * 10, 'button', `b${String(i)}`);
    const next = new RefTable(t.refs, t.counter);
    const removed = next.prune(new Set([10, 20, 30]));
    expect(removed).toEqual(['e4', 'e5', 'e6', 'e7', 'e8', 'e9', 'e10', 'e11']);
    expect(Object.keys(next.refs)).toEqual(['e1', 'e2', 'e3']);
    // a removed node coming back is a new element and gets a new ref
    expect(next.assign(40, 'button', 'b4')).toBe('e12');
  });
});
