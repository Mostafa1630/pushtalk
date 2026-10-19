// Browser implementation of AudioPlayer using one reusable <audio> element.
// Audio is fetched with the bearer token (the media endpoint is protected),
// turned into an object URL, and played. Blobs are cached briefly so a
// replay doesn't hit the network again.

import { ApiError } from "../api/client";
import { messageApi } from "../api/endpoints";
import { AutoplayBlockedError, type AudioPlayer, type QueueItem } from "./PlaybackQueue";

const CACHE_LIMIT = 30;

export class HtmlAudioPlayer implements AudioPlayer {
  private readonly audio = new Audio();
  private readonly cache = new Map<string, Blob>();
  private objectUrl: string | null = null;
  private abort: AbortController | null = null;
  private rate = 1;

  constructor() {
    this.audio.preload = "auto";
    // Speeding up speech without raising its pitch.
    this.audio.preservesPitch = true;
  }

  async play(item: QueueItem): Promise<void> {
    this.stop();
    const controller = new AbortController();
    this.abort = controller;

    const blob = await this.load(item.id, controller.signal);
    if (controller.signal.aborted) return new Promise<void>(() => {}); // superseded by stop()

    this.objectUrl = URL.createObjectURL(blob);
    const audio = this.audio;
    return new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("This audio message could not be decoded."));
      audio.src = this.objectUrl!;
      audio.currentTime = 0;
      audio.playbackRate = this.rate;
      audio.play().catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "NotAllowedError") reject(new AutoplayBlockedError());
        else if (err instanceof DOMException && err.name === "AbortError") {
          /* interrupted by stop(): the queue already moved on */
        } else reject(err instanceof Error ? err : new Error("Playback failed"));
      });
    });
  }

  /** Hold the position; resume() carries on from here. */
  pause(): void {
    this.audio.pause();
  }

  resume(): void {
    this.audio.play().catch(() => {
      /* the queue's watchdog handles a stream that refuses to restart */
    });
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.audio.playbackRate = rate;
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
    const audio = this.audio;
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    if (this.objectUrl) {
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  private async load(id: string, signal: AbortSignal): Promise<Blob> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    try {
      const blob = await messageApi.audio(id, signal);
      this.cache.set(id, blob);
      if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
      return blob;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw new Error("This audio file is no longer available.");
      if (err instanceof ApiError && err.status === 403) throw new Error("You no longer have access to this audio.");
      throw err;
    }
  }
}
