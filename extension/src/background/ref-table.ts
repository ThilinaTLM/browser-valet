// Pure ref bookkeeping for snapshots: stable, monotonic `eN` refs. No chrome.* access here so the
// rules can be unit-tested directly.

import type { RefInfo } from '../shared';

/**
 * Identity of a node. Backend node ids are per renderer process, so a node inside an
 * out-of-process iframe is keyed by the iframe's frame id as well.
 */
export type NodeKey = number | string;
export const nodeKey = (backendNodeId: number, frameId?: string): NodeKey =>
  frameId === undefined ? backendNodeId : `${frameId}:${String(backendNodeId)}`;

/** Where a node lives when it is not in the tab's own session. */
export interface NodeSession {
  sessionId: string;
  frameId: string;
}

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
  private readonly byNode = new Map<NodeKey, string>();
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
      this.byNode.set(nodeKey(v.backendNodeId, v.frameId), k);
    }
    this.next = Math.max(next, maxRef(this.refs) + 1, 1);
  }

  /** The ref for a node: its existing one, or a new one. Role and name are refreshed. */
  assign(backendNodeId: number, role: string, name: string, where?: NodeSession): string {
    const key = nodeKey(backendNodeId, where?.frameId);
    let ref = this.byNode.get(key);
    if (ref === undefined) {
      ref = `e${this.next++}`;
      this.byNode.set(key, ref);
    }
    this.refs[ref] = where
      ? { backendNodeId, role, name, sessionId: where.sessionId, frameId: where.frameId }
      : { backendNodeId, role, name };
    this.seen[ref] = { role, name };
    return ref;
  }

  /** Counter value to persist for the session. */
  get counter(): number {
    return this.next;
  }

  /**
   * Drop refs whose node is no longer present and return them (sorted by number). Refs inside
   * an iframe in `keepFrames` (one that could not be read this time) are kept.
   */
  prune(present: ReadonlySet<NodeKey>, keepFrames: ReadonlySet<string> = new Set()): string[] {
    const removed: string[] = [];
    for (const [ref, info] of Object.entries(this.refs)) {
      const key = nodeKey(info.backendNodeId, info.frameId);
      if (present.has(key) || (info.frameId !== undefined && keepFrames.has(info.frameId)))
        continue;
      delete this.refs[ref];
      this.byNode.delete(key);
      removed.push(ref);
    }
    return removed.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  }
}
