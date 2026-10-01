/**
 * Releases channel messages strictly in `seq` order, exactly once.
 *
 * The server assigns every ready message a gap-free per-channel seq
 * (1, 2, 3, ...). Messages can still reach the client out of order or twice:
 *   - live WebSocket events vs. the HTTP catch-up page after a reconnect,
 *   - two workers publishing seq 5 and 6 in the "wrong" order,
 *   - a Redis hiccup dropping an event entirely.
 * The sequencer dedupes by seq, holds back anything after a gap and reports
 * the gap so the caller can fetch `after_seq = lastSeq` to fill it.
 */
export interface Sequenced {
  seq: number;
}

export function historyCursorBeforePage<T extends Sequenced>(
  latestSeq: number,
  page: T[],
): number {
  return page.length === 0
    ? latestSeq
    : Math.max(0, Math.min(...page.map((message) => message.seq)) - 1);
}

export class MessageSequencer<T extends Sequenced> {
  private last: number;
  private readonly pending = new Map<number, T>();

  constructor(lastSeq = 0) {
    this.last = lastSeq;
  }

  /** Highest seq released so far (use as `after_seq` for catch-up). */
  get lastSeq(): number {
    return this.last;
  }

  /** True when messages are buffered behind a missing seq. */
  get hasGap(): boolean {
    return this.pending.size > 0;
  }

  /**
   * Offer one or more messages (any order, duplicates allowed).
   * Returns the messages that can now be applied, in seq order.
   */
  push(messages: T | T[]): T[] {
    for (const m of Array.isArray(messages) ? messages : [messages]) {
      if (m.seq > this.last && !this.pending.has(m.seq))
        this.pending.set(m.seq, m);
    }
    const released: T[] = [];
    let next = this.pending.get(this.last + 1);
    while (next !== undefined) {
      this.pending.delete(next.seq);
      this.last = next.seq;
      released.push(next);
      next = this.pending.get(this.last + 1);
    }
    return released;
  }

  /**
   * The server says the channel's latest seq is `latestSeq` (from `ready` or a
   * catch-up page). If we are behind, the caller must fetch the difference.
   */
  isBehind(latestSeq: number): boolean {
    return latestSeq > this.last;
  }
}
