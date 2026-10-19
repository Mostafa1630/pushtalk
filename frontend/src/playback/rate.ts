/**
 * Playback speed: 1x -> 1.5x -> 2x -> 1x.
 *
 * One speed for the whole app (not per message), remembered between visits.
 */

export const PLAYBACK_RATES = [1, 1.5, 2] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];
export const DEFAULT_RATE: PlaybackRate = 1;

/** The slice of Storage this module needs, so the tests can pass a fake. */
export interface RateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = "pushtalk.playbackRate";

/** Next speed in the cycle; anything unrecognised falls back to the first. */
export function nextRate(current: number): PlaybackRate {
  const index = PLAYBACK_RATES.indexOf(current as PlaybackRate);
  // indexOf is -1 for an unsupported value, which wraps back to the first rate.
  return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length] ?? DEFAULT_RATE;
}

export function rateLabel(rate: number): string {
  return `${rate}×`;
}

export function readStoredRate(storage: RateStorage = localStorage): PlaybackRate {
  try {
    const stored = Number(storage.getItem(STORAGE_KEY));
    return PLAYBACK_RATES.find((rate) => rate === stored) ?? DEFAULT_RATE;
  } catch {
    return DEFAULT_RATE;
  }
}

export function storeRate(rate: PlaybackRate, storage: RateStorage = localStorage): void {
  try {
    storage.setItem(STORAGE_KEY, String(rate));
  } catch {
    // The chosen speed still applies for this session.
  }
}
