import { describe, expect, it } from "vitest";
import { daySeparator, type DaySeparator } from "./dateSeparators";

// Wednesday 2026-10-14, local time, so the week (Monday start) is 12..18 Oct.
const NOW = new Date("2026-10-14T07:00:00");

const at = (iso: string, previous: string | null = null) =>
  daySeparator(iso, previous, "en", NOW);

const text = (separator: DaySeparator | null) =>
  separator?.kind === "text" ? separator.text : null;

describe("daySeparator", () => {
  it("labels the first message of today", () => {
    expect(at("2026-10-14T07:02:00")).toEqual({
      kind: "label",
      key: "dateToday",
    });
  });

  it("returns nothing for a second message on the same day", () => {
    expect(at("2026-10-14T07:02:00", "2026-10-14T06:59:00")).toBeNull();
  });

  it("labels yesterday instead of showing the weekday", () => {
    expect(at("2026-10-13T19:00:00")).toEqual({
      kind: "label",
      key: "dateYesterday",
    });
  });

  it("shows the weekday name for an earlier day of this week", () => {
    expect(text(at("2026-10-12T09:00:00"))).toBe("Monday");
  });

  it("shows the full date once the day is outside this week", () => {
    // Sunday 11 Oct is the day before the current week started.
    const sunday = text(at("2026-10-11T09:00:00"));
    expect(sunday).not.toBe("Sunday");
    expect(sunday).toMatch(/11/);
    expect(sunday).toMatch(/2026/);
  });

  it("uses the calendar week, not the last seven days", () => {
    // Wednesday a week ago is within 7 days but in the previous week.
    expect(text(at("2026-10-07T09:00:00"))).not.toBe("Wednesday");
  });

  it("switches to Arabic weekday names and dates", () => {
    expect(text(daySeparator("2026-10-12T09:00:00", null, "ar", NOW))).toBe(
      "الاثنين",
    );
    expect(text(daySeparator("2026-10-11T09:00:00", null, "ar", NOW))).toMatch(
      /أكتوبر|October/,
    );
  });

  it("compares local days, not raw timestamps", () => {
    // 23:59 local and 00:01 the next local day are 2 minutes apart.
    expect(at("2026-10-14T00:01:00", "2026-10-13T23:59:00")).toEqual({
      kind: "label",
      key: "dateToday",
    });
  });

  it("ignores an unparseable timestamp", () => {
    expect(at("not-a-date")).toBeNull();
    // ...but still separates when only the previous one is broken.
    expect(at("2026-10-14T07:02:00", "not-a-date")).toEqual({
      kind: "label",
      key: "dateToday",
    });
  });
});
