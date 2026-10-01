import { describe, expect, it } from "vitest";
import { historyCursorBeforePage, MessageSequencer } from "./MessageSequencer";

const m = (seq: number) => ({ seq, id: `m${seq}` });

describe("MessageSequencer", () => {
  it("releases in-order messages immediately", () => {
    const s = new MessageSequencer();
    expect(s.push(m(1)).map((x) => x.seq)).toEqual([1]);
    expect(s.push(m(2)).map((x) => x.seq)).toEqual([2]);
    expect(s.lastSeq).toBe(2);
  });

  it("rehydrates a channel from the latest history page", () => {
    const history = [m(48), m(49), m(50)];
    const cursor = historyCursorBeforePage(50, history);
    const s = new MessageSequencer(cursor);

    expect(s.push(history).map((message) => message.seq)).toEqual([48, 49, 50]);
    expect(s.lastSeq).toBe(50);
  });

  it("starts at latest seq when no ready history is available", () => {
    expect(historyCursorBeforePage(50, [])).toBe(50);
  });

  it("holds messages behind a gap and releases them once it is filled", () => {
    const s = new MessageSequencer(100); // user has seen up to 100
    expect(s.push(m(102))).toEqual([]);
    expect(s.push(m(103))).toEqual([]);
    expect(s.hasGap).toBe(true);
    expect(s.lastSeq).toBe(100); // catch-up must request after_seq=100

    expect(s.push(m(101)).map((x) => x.seq)).toEqual([101, 102, 103]);
    expect(s.hasGap).toBe(false);
  });

  it("drops duplicates from live events overlapping with catch-up pages", () => {
    const s = new MessageSequencer();
    s.push([m(1), m(2)]);
    expect(s.push([m(2), m(3), m(3)]).map((x) => x.seq)).toEqual([3]);
    expect(s.push(m(1))).toEqual([]);
  });

  it("accepts a catch-up page in any order", () => {
    const s = new MessageSequencer(101);
    expect(s.push([m(104), m(102), m(103)]).map((x) => x.seq)).toEqual([
      102, 103, 104,
    ]);
  });

  it("reconnect scenario: B saw 101, missed 102-103, then live 104 arrives before catch-up", () => {
    const s = new MessageSequencer(101);
    expect(s.push(m(104))).toEqual([]); // live event after reconnect, held
    expect(s.isBehind(104)).toBe(true);
    // HTTP catch-up after_seq=101 returns 102..104 (104 duplicated)
    expect(s.push([m(102), m(103), m(104)]).map((x) => x.seq)).toEqual([
      102, 103, 104,
    ]);
    expect(s.isBehind(104)).toBe(false);
  });
});
