// Pure ref bookkeeping for snapshots: stable, monotonic `eN` refs. No chrome.* access here so the
// rules can be unit-tested directly.

import type { RefInfo } from '../shared';

const REF_NUM = /^e(\d+)$/;

/** Highest number among existing refs (0 when empty). */
function maxRef(refs: Record<string, RefInfo>): number {
  let max = 0;
  for (const k of Object.keys(refs)) {
    const n = Number(REF_NUM.exec(k)?.[1] ?? 0);
    if (n > max) max = n;
  }
  return max;
}

/**
 * The refs of one tab while a snapshot is being taken. Nodes already known keep their ref; new
 * nodes take `e<next>`. `next` only ever grows, so a ref number is never reused for another
 * element, even after the tab's refs were cleared by a navigation.
 */
export class RefTable {
  /** Every known ref (previous snapshots plus new ones). */
  readonly refs: Record<string, RefInfo>;
  /** The refs seen by this snapshot, as `{role, name}` for output. */
  readonly seen: Record<string, { role: string; name: string }> = {};
  private readonly byNode = new Map<number, string>();
  private next: number;

  /**
   * @param prev the tab's refs from earlier snapshots of the current document (copied)
   * @param next the session's counter; raised above any ref in `prev` (another session may have
   *   used the same tab)
   */
  constructor(prev: Record<string, RefInfo> | undefined, next: number) {
    this.refs = {};
    for (const [k, v] of Object.entries(prev ?? {})) {
      this.refs[k] = { ...v };
      this.byNode.set(v.backendNodeId, k);
    }
    this.next = Math.max(next, maxRef(this.refs) + 1, 1);
  }

  /** The ref for a node: its existing one, or a new one. Role and name are refreshed. */
  assign(backendNodeId: number, role: string, name: string): string {
    let ref = this.byNode.get(backendNodeId);
    if (ref === undefined) {
      ref = `e${this.next++}`;
      this.byNode.set(backendNodeId, ref);
    }
    this.refs[ref] = { backendNodeId, role, name };
    this.seen[ref] = { role, name };
    return ref;
  }

  /** Counter value to persist for the session. */
  get counter(): number {
    return this.next;
  }

  /** Drop refs whose node is no longer present and return them (sorted by number). */
  prune(present: ReadonlySet<number>): string[] {
    const removed: string[] = [];
    for (const [ref, info] of Object.entries(this.refs)) {
      if (present.has(info.backendNodeId)) continue;
      delete this.refs[ref];
      this.byNode.delete(info.backendNodeId);
      removed.push(ref);
    }
    return removed.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  }
}
