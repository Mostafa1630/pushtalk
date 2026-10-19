import { describe, expect, it } from "vitest";
import {
  DEFAULT_RATE,
  nextRate,
  PLAYBACK_RATES,
  rateLabel,
  readStoredRate,
  storeRate,
  type RateStorage,
} from "./rate";

const STORAGE_KEY = "pushtalk.playbackRate";

function memoryStorage(initial: Record<string, string> = {}): RateStorage & {
  values: Record<string, string>;
} {
  const values: Record<string, string> = { ...initial };
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
  };
}

describe("nextRate", () => {
  it("cycles 1 -> 1.5 -> 2 -> 1", () => {
    expect(nextRate(1)).toBe(1.5);
    expect(nextRate(1.5)).toBe(2);
    expect(nextRate(2)).toBe(1);
  });

  it("starts over from an unknown value", () => {
    expect(nextRate(3)).toBe(DEFAULT_RATE);
    expect(nextRate(Number.NaN)).toBe(DEFAULT_RATE);
  });

  it("only ever produces supported rates", () => {
    let rate: number = DEFAULT_RATE;
    for (let step = 0; step < 12; step++) {
      rate = nextRate(rate);
      expect(PLAYBACK_RATES).toContain(rate);
    }
  });
});

describe("rateLabel", () => {
  it("formats the speed with a multiplication sign", () => {
    expect(rateLabel(1)).toBe("1×");
    expect(rateLabel(1.5)).toBe("1.5×");
    expect(rateLabel(2)).toBe("2×");
  });
});

describe("stored rate", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();
    storeRate(2, storage);
    expect(storage.values[STORAGE_KEY]).toBe("2");
    expect(readStoredRate(storage)).toBe(2);
  });

  it("falls back to 1x when nothing is stored", () => {
    expect(readStoredRate(memoryStorage())).toBe(DEFAULT_RATE);
  });

  it("ignores a stored value that is not a supported rate", () => {
    expect(readStoredRate(memoryStorage({ [STORAGE_KEY]: "7" }))).toBe(DEFAULT_RATE);
    expect(readStoredRate(memoryStorage({ [STORAGE_KEY]: "abc" }))).toBe(DEFAULT_RATE);
  });

  it("survives storage that throws (private mode)", () => {
    const broken: RateStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readStoredRate(broken)).toBe(DEFAULT_RATE);
    expect(() => storeRate(1.5, broken)).not.toThrow();
  });
});
