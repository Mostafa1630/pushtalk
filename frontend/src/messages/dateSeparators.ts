import type { Language, TranslationKey } from "../i18n";

/** Divider shown above a message: a translation key or pre-formatted Intl text. */
export type DaySeparator =
  | { kind: "label"; key: TranslationKey }
  | { kind: "text"; text: string };

function startOfDay(date: Date): Date {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}

function localDay(createdAt: string): Date | null {
  const parsed = Date.parse(createdAt);
  return Number.isNaN(parsed) ? null : startOfDay(new Date(parsed));
}

/**
 * Divider for the message sent at `createdAt`, or null when it shares its local
 * day with `previousCreatedAt` - so days are separated, not individual messages.
 *
 * Today/yesterday get a relative label; other days of the current week (Monday
 * start) get the weekday name; anything older gets the full date.
 */
export function daySeparator(
  createdAt: string,
  previousCreatedAt: string | null,
  language: Language,
  now = new Date(),
): DaySeparator | null {
  const day = localDay(createdAt);
  if (day === null) return null;

  const previous = previousCreatedAt === null ? null : localDay(previousCreatedAt);
  if (previous !== null && previous.getTime() === day.getTime()) return null;

  const today = startOfDay(now);
  if (day.getTime() === today.getTime())
    return { kind: "label", key: "dateToday" };

  // setDate() rather than -86400000 ms, so a DST shift cannot skip a day.
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day.getTime() === yesterday.getTime())
    return { kind: "label", key: "dateYesterday" };

  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const locale = language === "ar" ? "ar" : "en";
  if (day.getTime() >= weekStart.getTime())
    return {
      kind: "text",
      text: new Intl.DateTimeFormat(locale, { weekday: "long" }).format(day),
    };

  return {
    kind: "text",
    text: new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(day),
  };
}
