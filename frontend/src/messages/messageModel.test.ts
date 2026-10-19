import { describe, expect, it } from "vitest";
import {
  mergeMessage,
  ownStatusLabel,
  sortMessages,
  type ChatMessage,
} from "./messageModel";

const base: ChatMessage = {
  key: "k1",
  id: "m1",
  senderId: 1,
  senderName: "alice",
  senderAvatarUrl: null,
  status: "processing",
  seq: null,
  durationMs: null,
  waveform: null,
  transcript: null,
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-01-01T00:00:00Z",
  receipts: null,
  playedByMe: false,
  unheard: false,
};

describe("messageModel", () => {
  it("never downgrades: a late 202 'processing' response doesn't undo 'ready'", () => {
    const ready = { ...base, status: "ready" as const, seq: 5 };
    const merged = mergeMessage(ready, { ...base, status: "processing" });
    expect(merged.status).toBe("ready");
    expect(merged.seq).toBe(5);
  });

  it("updates transcript when a late transcript arrives", () => {
    const ready = { ...base, status: "ready" as const, seq: 1 };
    const withText = mergeMessage(ready, {
      ...base,
      status: "ready" as const,
      seq: 1,
      transcript: "Hello world",
    });
    expect(withText.transcript).toBe("Hello world");
  });

  it("drops the retained audio blob once the server accepted the upload", () => {
    const uploading = {
      ...base,
      id: null,
      status: "uploading" as const,
      blob: new Blob(["x"]),
    };
    expect(mergeMessage(uploading, { ...base }).blob).toBeUndefined();
  });

  it("sorts ready messages by seq and keeps in-flight ones at the end", () => {
    const list = sortMessages([
      { ...base, key: "p", status: "processing" },
      { ...base, key: "b", status: "ready", seq: 2 },
      { ...base, key: "a", status: "ready", seq: 1 },
    ]);
    expect(list.map((m) => m.key)).toEqual(["a", "b", "p"]);
  });

  it("derives sent -> delivered -> played labels from receipts", () => {
    const ready = { ...base, status: "ready" as const, seq: 1 };
    expect(
      ownStatusLabel({
        ...ready,
        receipts: { recipients: 2, delivered: 0, played: 0 },
      }),
    ).toBe("Sent");
    expect(
      ownStatusLabel({
        ...ready,
        receipts: { recipients: 2, delivered: 1, played: 0 },
      }),
    ).toBe("Delivered 1/2");
    expect(
      ownStatusLabel({
        ...ready,
        receipts: { recipients: 2, delivered: 2, played: 1 },
      }),
    ).toBe("Played 1/2");
    expect(
      ownStatusLabel({
        ...ready,
        receipts: { recipients: 2, delivered: 2, played: 2 },
      }),
    ).toBe("Played");
    expect(ownStatusLabel({ ...base, status: "failed" })).toBe("Failed");
  });
});
