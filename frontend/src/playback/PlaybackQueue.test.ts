import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoplayBlockedError, PlaybackQueue, type AudioPlayer, type QueueItem } from "./PlaybackQueue";

const ME = 1;
const OTHER = 2;

/** Fake player: each play() returns a promise the test resolves/rejects by hand. */
class FakePlayer implements AudioPlayer {
  started: string[] = [];
  stops = 0;
  pauses = 0;
  resumes = 0;
  rates: number[] = [];
  /** Every play() call, in order (the same id can be played twice). */
  calls: { id: string; resolve: () => void; reject: (e: unknown) => void }[] = [];
  private pending = new Map<string, { resolve: () => void; reject: (e: unknown) => void }>();

  play(item: QueueItem): Promise<void> {
    this.started.push(item.id);
    return new Promise((resolve, reject) => {
      this.pending.set(item.id, { resolve, reject });
      this.calls.push({ id: item.id, resolve, reject });
    });
  }
  stop(): void {
    this.stops++;
  }
  pause(): void {
    this.pauses++;
  }
  resume(): void {
    this.resumes++;
  }
  setRate(rate: number): void {
    this.rates.push(rate);
  }
  finish(id: string): void {
    this.pending.get(id)!.resolve();
    this.pending.delete(id);
  }
  fail(id: string, err: unknown): void {
    this.pending.get(id)!.reject(err);
    this.pending.delete(id);
  }
}

const item = (id: string, seq: number, senderId = OTHER, durationMs: number | null = 1000): QueueItem => ({
  id,
  seq,
  senderId,
  durationMs,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("PlaybackQueue", () => {
  let player: FakePlayer;
  let queue: PlaybackQueue;
  let played: string[];
  let errors: string[];

  beforeEach(() => {
    player = new FakePlayer();
    played = [];
    errors = [];
    queue = new PlaybackQueue(player, {
      selfUserId: ME,
      onPlayed: (i) => played.push(i.id),
      onError: (i) => errors.push(i.id),
    });
  });

  it("plays one message at a time, in sequence", async () => {
    queue.enqueue(item("a", 1));
    queue.enqueue(item("b", 2));
    queue.enqueue(item("c", 3));

    expect(player.started).toEqual(["a"]); // never two at once
    expect(queue.snapshot().queued.map((q) => q.id)).toEqual(["b", "c"]);

    player.finish("a");
    await flush();
    expect(player.started).toEqual(["a", "b"]);
    player.finish("b");
    await flush();
    player.finish("c");
    await flush();
    expect(played).toEqual(["a", "b", "c"]);
    expect(queue.snapshot().current).toBeNull();
  });

  it("a message arriving while another plays waits for it to end", async () => {
    queue.enqueue(item("a", 1));
    await flush();
    queue.enqueue(item("b", 2));
    expect(player.started).toEqual(["a"]);
    player.finish("a");
    await flush();
    expect(player.started).toEqual(["a", "b"]);
  });

  it("orders by seq even if messages are enqueued out of order", async () => {
    queue.enqueue(item("first", 10));
    queue.enqueue(item("c", 13));
    queue.enqueue(item("b", 12));
    queue.enqueue(item("a", 11));
    expect(queue.snapshot().queued.map((q) => q.seq)).toEqual([11, 12, 13]);
  });

  it("never auto-plays the user's own messages", () => {
    expect(queue.enqueue(item("mine", 1, ME))).toBe(false);
    expect(player.started).toEqual([]);
  });

  it("plays own message when requested manually", () => {
    expect(queue.enqueue({ ...item("mine", 1, ME), manual: true })).toBe(true);
    expect(player.started).toEqual(["mine"]);
  });

  it("ignores duplicates (queued, playing, or already played)", async () => {
    queue.enqueue(item("a", 1));
    expect(queue.enqueue(item("a", 1))).toBe(false); // currently playing
    queue.enqueue(item("b", 2));
    expect(queue.enqueue(item("b", 2))).toBe(false); // already queued
    player.finish("a");
    await flush();
    expect(queue.enqueue(item("a", 1))).toBe(false); // already played (e.g. catch-up duplicate)
  });

  it("holds incoming messages while recording and resumes afterwards", async () => {
    queue.setPaused("recording", true);
    queue.enqueue(item("a", 1));
    queue.enqueue(item("b", 2));
    expect(player.started).toEqual([]);

    queue.setPaused("recording", false);
    expect(player.started).toEqual(["a"]);
  });

  it("recording interrupts the current message; it replays from the start afterwards", async () => {
    queue.enqueue(item("a", 1));
    queue.enqueue(item("b", 2));
    expect(player.started).toEqual(["a"]);

    queue.setPaused("recording", true);
    expect(player.stops).toBe(1);
    expect(queue.snapshot().queued.map((q) => q.id)).toEqual(["a", "b"]);

    // The interrupted play() settling late must not corrupt state.
    player.finish("a");
    await flush();
    expect(played).toEqual([]);

    queue.setPaused("recording", false);
    expect(player.started).toEqual(["a", "a"]);
  });

  it("a stale play() settling after an interrupt does not complete the replay", async () => {
    queue.enqueue(item("a", 1));
    queue.enqueue(item("b", 2));
    queue.setPaused("recording", true);
    queue.setPaused("recording", false); // "a" starts again (second call)
    expect(player.started).toEqual(["a", "a"]);

    player.calls[0]!.resolve(); // the FIRST, interrupted playback ends late
    await flush();
    expect(played).toEqual([]); // not counted as played
    expect(queue.snapshot().current?.id).toBe("a"); // replay still in progress
    expect(player.started).toEqual(["a", "a"]); // "b" did not start over it

    player.calls[1]!.resolve();
    await flush();
    expect(played).toEqual(["a"]);
    expect(player.started).toEqual(["a", "a", "b"]);
  });

  it("autoplay blocked: keeps the message, pauses, and resumes on unlock", async () => {
    queue.enqueue(item("a", 1));
    queue.enqueue(item("b", 2));
    player.fail("a", new AutoplayBlockedError());
    await flush();

    const snap = queue.snapshot();
    expect(snap.paused).toContain("blocked");
    expect(snap.current).toBeNull();
    expect(snap.queued.map((q) => q.id)).toEqual(["a", "b"]); // nothing lost
    expect(errors).toEqual([]);

    queue.unlock();
    expect(player.started).toEqual(["a", "a"]);
  });

  it("a broken message is skipped and reported; the queue continues", async () => {
    queue.enqueue(item("a", 1));
    queue.enqueue(item("b", 2));
    player.fail("a", new Error("404"));
    await flush();
    expect(errors).toEqual(["a"]);
    expect(player.started).toEqual(["a", "b"]);
    player.finish("b");
    await flush();
    expect(played).toEqual(["b"]);
  });

  it("a synchronous throw from the player is handled like a playback error", async () => {
    const throwing: AudioPlayer = {
      play: () => {
        throw new Error("boom");
      },
      stop: () => {},
      pause: () => {},
      resume: () => {},
      setRate: () => {},
    };
    const q = new PlaybackQueue(throwing, { selfUserId: ME, onError: (i) => errors.push(i.id) });
    q.enqueue(item("a", 1));
    await flush();
    expect(errors).toEqual(["a"]);
    expect(q.snapshot().current).toBeNull();
  });

  it("remove() drops a queued item and stops it if it is playing", async () => {
    queue.enqueue(item("a", 1));
    queue.enqueue(item("b", 2));
    queue.enqueue(item("c", 3));
    queue.remove("c"); // played on another device
    expect(queue.snapshot().queued.map((q) => q.id)).toEqual(["b"]);
    queue.remove("a"); // currently playing
    expect(player.stops).toBe(1);
    expect(player.started).toEqual(["a", "b"]);
    expect(queue.enqueue(item("c", 3))).toBe(false); // removed = treated as played
  });

  it("inactive (follower tab) never plays but keeps queueing", () => {
    queue.setPaused("inactive", true);
    queue.enqueue(item("a", 1));
    expect(player.started).toEqual([]);
    queue.setPaused("inactive", false);
    expect(player.started).toEqual(["a"]);
  });

  it("multiple pause reasons must all clear before playback resumes", () => {
    queue.setPaused("recording", true);
    queue.setPaused("blocked", true);
    queue.enqueue(item("a", 1));
    queue.setPaused("recording", false);
    expect(player.started).toEqual([]);
    queue.unlock();
    expect(player.started).toEqual(["a"]);
  });

  it("markPlayed prevents history items from being auto-queued", () => {
    queue.markPlayed(["old"]);
    expect(queue.enqueue(item("old", 1))).toBe(false);
  });

  it("clear() stops playback and empties the queue", () => {
    queue.enqueue(item("a", 1));
    queue.enqueue(item("b", 2));
    queue.clear();
    expect(player.stops).toBe(1);
    expect(queue.snapshot()).toEqual({ current: null, queued: [], paused: [], userPaused: false });
  });

  describe("user pause / resume", () => {
    it("pauses in place and resumes without replaying", async () => {
      queue.enqueue(item("a", 1));
      queue.enqueue(item("b", 2));
      expect(player.started).toEqual(["a"]);

      queue.toggleCurrent();
      expect(player.pauses).toBe(1);
      expect(player.stops).toBe(0); // the position is kept, not thrown away
      expect(queue.snapshot().userPaused).toBe(true);
      expect(queue.snapshot().current?.id).toBe("a");

      queue.toggleCurrent();
      expect(player.resumes).toBe(1);
      expect(queue.snapshot().userPaused).toBe(false);
      expect(player.started).toEqual(["a"]); // never restarted

      player.finish("a");
      await flush();
      expect(player.started).toEqual(["a", "b"]);
    });

    it("does not start the next message while the current one is paused", () => {
      queue.enqueue(item("a", 1));
      queue.toggleCurrent();
      queue.enqueue(item("b", 2));
      expect(player.started).toEqual(["a"]);
      expect(queue.snapshot().queued.map((q) => q.id)).toEqual(["b"]);
    });

    it("clears the flag once the message ends", async () => {
      queue.enqueue(item("a", 1));
      queue.toggleCurrent();
      expect(queue.snapshot().userPaused).toBe(true);
      queue.toggleCurrent();
      player.finish("a");
      await flush();
      expect(queue.snapshot().userPaused).toBe(false);
    });

    it("an interrupt while paused replays from the start afterwards", () => {
      queue.enqueue(item("a", 1));
      queue.toggleCurrent();
      queue.setPaused("recording", true);
      expect(queue.snapshot().userPaused).toBe(false);
      expect(queue.snapshot().queued.map((q) => q.id)).toEqual(["a"]);
      queue.setPaused("recording", false);
      expect(player.started).toEqual(["a", "a"]);
    });

    it("is a no-op when nothing is playing", () => {
      queue.toggleCurrent();
      expect(player.pauses).toBe(0);
      expect(queue.snapshot().userPaused).toBe(false);
    });
  });

  it("forwards the playback speed to the player", () => {
    queue.setRate(1.5);
    queue.setRate(2);
    expect(player.rates).toEqual([1.5, 2]);
  });

  describe("watchdog", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("skips a message that never ends or errors (stalled stream)", async () => {
      const q = new PlaybackQueue(player, {
        selfUserId: ME,
        watchdogSlackMs: 1000,
        onError: (i) => errors.push(i.id),
      });
      q.enqueue(item("stuck", 1, OTHER, 2000));
      q.enqueue(item("next", 2));
      await vi.advanceTimersByTimeAsync(2999);
      expect(player.started).toEqual(["stuck"]);
      await vi.advanceTimersByTimeAsync(2);
      expect(errors).toEqual(["stuck"]);
      expect(player.started).toEqual(["stuck", "next"]);
    });

    it("does not fire after the message ended normally", async () => {
      const q = new PlaybackQueue(player, { selfUserId: ME, watchdogSlackMs: 1000, onError: (i) => errors.push(i.id) });
      q.enqueue(item("a", 1, OTHER, 500));
      player.finish("a");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(errors).toEqual([]);
    });

    it("stays off while the user has paused and gets a fresh budget on resume", async () => {
      const q = new PlaybackQueue(player, { selfUserId: ME, watchdogSlackMs: 1000, onError: (i) => errors.push(i.id) });
      q.enqueue(item("a", 1, OTHER, 2000));
      q.toggleCurrent();
      await vi.advanceTimersByTimeAsync(60_000); // a long pause is not a stall
      expect(errors).toEqual([]);

      q.toggleCurrent();
      await vi.advanceTimersByTimeAsync(2999);
      expect(errors).toEqual([]);
      await vi.advanceTimersByTimeAsync(2);
      expect(errors).toEqual(["a"]);
    });
  });

  it("emits snapshots on every change", () => {
    const snapshots: number[] = [];
    const q = new PlaybackQueue(player, { selfUserId: ME, onChange: (s) => snapshots.push(s.queued.length) });
    q.enqueue(item("a", 1));
    q.enqueue(item("b", 2));
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
  });
});
