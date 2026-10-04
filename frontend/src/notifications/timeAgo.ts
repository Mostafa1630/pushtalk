import type { TranslationKey } from "../i18n";

export interface TimeAgo {
  key: TranslationKey;
  count?: number;
}

/** Buckets a timestamp into a coarse relative-time bucket for i18n rendering. */
export function timeAgo(createdAt: string, now = Date.now()): TimeAgo | null {
  const ms = now - Date.parse(createdAt);
  if (Number.isNaN(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return { key: "timeJustNow" };
  if (minutes < 60) return { key: "timeMinutesAgo", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { key: "timeHoursAgo", count: hours };
  return { key: "timeDaysAgo", count: Math.floor(hours / 24) };
}
