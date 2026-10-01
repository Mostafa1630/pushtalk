/**
 * Sequential, single-voice playback queue.
 *
 * Pure logic, no DOM: the actual audio element sits behind the AudioPlayer
 * interface, so every rule below is unit-tested in isolation
 * (PlaybackQueue.test.ts).
 *
 * Rules
 *  - Only one message plays at a time; the next starts when the previous ends.
 *  - Items are ordered by channel seq, whatever order they were enqueued in.
 *  - The user's own messages are never auto-played.
 *  - A message is queued at most once, and never re-queued after it played.
 *  - Playback pauses for "reasons" (recording, autoplay blocked, not the
 *    leader tab). While any reason is active nothing plays; items keep queueing.
 *  - Starting to record interrupts the current message; it is put back at the
 *    head of the queue and replays from the start when recording ends.
 *  - Autoplay blocked by the browser: the item goes back to the head, the
 *    queue pauses with reason "blocked" until the user interacts (unlock()).
 *  - Any other playback error (404, decode error, network) skips that item,
 *    reports it, and continues with the next one - the queue never gets stuck.
 *  - A watchdog skips an item that neither ends nor errors (stalled stream).
 */

export interface QueueItem {
  id: string;
  seq: number;
  senderId: number;
  durationMs: number | null;
  /** Manual play (user clicked): allowed even for own / already-played items. */
  manual?: boolean;
}

export interface AudioPlayer {
  /** Resolves when playback ends, rejects on failure. */
  play(item: QueueItem): Promise<void>;
  /** Stop immediately; the pending play() promise may settle or not. */
  stop(): void;
}

/** Thrown by an AudioPlayer when the browser refuses to play without a gesture. */
export class AutoplayBlockedError extends Error {
  constructor() {
    super("Autoplay blocked by the browser");
    this.name = "AutoplayBlockedError";
  }
}

export type PauseReason = "recording" | "blocked" | "inactive";

export interface QueueSnapshot {
  current: QueueItem | null;
  queued: QueueItem[];
  paused: PauseReason[];
}

export interface PlaybackQueueOptions {
  selfUserId: number;
  onPlayed?: (item: QueueItem) => void;
  onError?: (item: QueueItem, error: unknown) => void;
  onChange?: (snapshot: QueueSnapshot) => void;
  /** Extra time allowed beyond the known duration before the watchdog fires. */
  watchdogSlackMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const DEFAULT_WATCHDOG_SLACK_MS = 8_000;
const UNKNOWN_DURATION_WATCHDOG_MS = 75_000; // > 60 s max message length

export class PlaybackQueue {
  private queued: QueueItem[] = [];
  private current: QueueItem | null = null;
  private readonly played = new Set<string>();
  private readonly paused = new Set<PauseReason>();
  /** Incremented on every start/stop so late promise settlements are ignored. */
  private generation = 0;
  private watchdog: unknown = null;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly player: AudioPlayer,
    private readonly opts: PlaybackQueueOptions,
  ) {
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  // ---- public API -----------------------------------------------------------

  /** Add an incoming message. Returns false if it was ignored. */
  enqueue(item: QueueItem): boolean {
    if (!item.manual && item.senderId === this.opts.selfUserId) return false;
    if (!item.manual && this.played.has(item.id)) return false;
    if (this.current?.id === item.id || this.queued.some((q) => q.id === item.id)) return false;

    if (item.manual) {
      this.queued.unshift(item); // user explicitly asked: play it next
    } else {
      // Keep seq order even if items arrive out of order. Manual items stay first.
      const idx = this.queued.findIndex((q) => !q.manual && q.seq > item.seq);
      if (idx === -1) this.queued.push(item);
      else this.queued.splice(idx, 0, item);
    }
    this.emit();
    this.pump();
    return true;
  }

  /** Remove a message (e.g. it was played on another device of the same user). */
  remove(id: string): void {
    this.played.add(id);
    const before = this.queued.length;
    this.queued = this.queued.filter((q) => q.id !== id);
    if (this.current?.id === id) {
      this.stopCurrent(false);
      this.pump();
    }
    if (before !== this.queued.length) this.emit();
  }

  /** Mark ids as already played so they never auto-play (history load). */
  markPlayed(ids: Iterable<string>): void {
    for (const id of ids) this.played.add(id);
  }

  setPaused(reason: PauseReason, on: boolean): void {
    if (on === this.paused.has(reason)) return;
    if (on) {
      this.paused.add(reason);
      // Anything playing is interrupted and will replay from the start later.
      if (this.current) this.stopCurrent(true);
    } else {
      this.paused.delete(reason);
    }
    this.emit();
    this.pump();
  }

  /** Call from a user gesture after an AutoplayBlockedError. */
  unlock(): void {
    this.setPaused("blocked", false);
  }

  /** Stop everything (channel closed). */
  clear(): void {
    this.queued = [];
    if (this.current) this.stopCurrent(false);
    this.emit();
  }

  snapshot(): QueueSnapshot {
    return { current: this.current, queued: [...this.queued], paused: [...this.paused] };
  }

  // ---- internals ------------------------------------------------------------

  private pump(): void {
    if (this.current || this.paused.size > 0) return;
    const next = this.queued.shift();
    if (!next) return;
    this.current = next;
    const generation = ++this.generation;
    this.armWatchdog(next, generation);
    this.emit();

    let promise: Promise<void>;
    try {
      promise = this.player.play(next);
    } catch (err) {
      promise = Promise.reject(err);
    }
    promise.then(
      () => this.settle(generation, null),
      (err: unknown) => this.settle(generation, err ?? new Error("Playback failed")),
    );
  }

  private settle(generation: number, error: unknown): void {
    if (generation !== this.generation || !this.current) return; // stale: stopped/replaced meanwhile
    const item = this.current;
    this.disarmWatchdog();
    this.current = null;

    if (error instanceof AutoplayBlockedError) {
      this.queued.unshift(item);
      this.paused.add("blocked");
    } else if (error) {
      this.played.add(item.id); // don't retry a broken item forever
      this.opts.onError?.(item, error);
    } else {
      this.played.add(item.id);
      this.opts.onPlayed?.(item);
    }
    this.emit();
    this.pump();
  }

  private stopCurrent(requeue: boolean): void {
    const item = this.current;
    this.generation++; // invalidate the pending play() promise
    this.disarmWatchdog();
    this.current = null;
    this.player.stop();
    if (item && requeue) this.queued.unshift(item);
  }

  private armWatchdog(item: QueueItem, generation: number): void {
    const slack = this.opts.watchdogSlackMs ?? DEFAULT_WATCHDOG_SLACK_MS;
    const limit = item.durationMs != null ? item.durationMs + slack : UNKNOWN_DURATION_WATCHDOG_MS;
    this.watchdog = this.setTimer(() => {
      if (generation !== this.generation) return;
      this.player.stop();
      this.settle(generation, new Error("Playback stalled"));
    }, limit);
  }

  private disarmWatchdog(): void {
    if (this.watchdog !== null) this.clearTimer(this.watchdog);
    this.watchdog = null;
  }

  private emit(): void {
    this.opts.onChange?.(this.snapshot());
  }
}
