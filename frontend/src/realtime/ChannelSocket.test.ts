import { beforeEach, describe, expect, it } from "vitest";
import type { ServerEvent } from "../api/types";
import { backoffDelay } from "./backoff";
import { ChannelSocket, type ConnectionState } from "./ChannelSocket";

class FakeWS {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  // test helpers
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(event: ServerEvent) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

describe("backoffDelay", () => {
  it("grows exponentially and is capped", () => {
    const max = () => 1; // worst case of the jitter
    expect(backoffDelay(0, { random: max })).toBe(500);
    expect(backoffDelay(1, { random: max })).toBe(1000);
    expect(backoffDelay(3, { random: max })).toBe(4000);
    expect(backoffDelay(20, { random: max })).toBe(15000);
  });

  it("jitter stays within [base/2, cap]", () => {
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(4);
      expect(d).toBeGreaterThanOrEqual(250);
      expect(d).toBeLessThanOrEqual(8000);
    }
  });
});

describe("ChannelSocket", () => {
  let sockets: FakeWS[];
  let timers: { fn: () => void; ms: number }[];
  let states: ConnectionState[];
  let events: ServerEvent[];
  let fatal: number[];
  let socket: ChannelSocket;

  beforeEach(() => {
    sockets = [];
    timers = [];
    states = [];
    events = [];
    fatal = [];
    socket = new ChannelSocket({
      url: "ws://test/api/ws/channels/1",
      getToken: () => "jwt",
      onEvent: (e) => events.push(e),
      onState: (s) => states.push(s),
      onFatal: (code) => fatal.push(code),
      createSocket: () => {
        const ws = new FakeWS();
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
      setTimer: (fn, ms) => timers.push({ fn, ms }) - 1,
      clearTimer: () => {},
      random: () => 1,
    });
  });

  it("authenticates with a hello frame (token not in the URL)", () => {
    socket.connect();
    sockets[0]!.open();
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ type: "hello", token: "jwt" });
  });

  it("reconnects with growing backoff after unexpected drops, and resets after ready", () => {
    socket.connect();
    sockets[0]!.drop();
    expect(states.at(-1)).toBe("reconnecting");
    expect(timers.at(-1)!.ms).toBe(500);

    timers.at(-1)!.fn(); // retry #1
    sockets[1]!.drop();
    expect(timers.at(-1)!.ms).toBe(1000); // grows

    timers.at(-1)!.fn(); // retry #2 succeeds
    sockets[2]!.open();
    sockets[2]!.receive({ type: "ready", user_id: 1, latest_seq: 0, online: [1] });
    expect(states.at(-1)).toBe("open");

    sockets[2]!.drop();
    expect(timers.filter((t) => t.ms !== 15000).at(-1)!.ms).toBe(500); // backoff reset
  });

  it("does not reconnect on auth/permission close codes", () => {
    socket.connect();
    sockets[0]!.drop(4403);
    expect(fatal).toEqual([4403]);
    expect(states.at(-1)).toBe("closed");
    expect(timers).toEqual([]);
  });

  it("buffers receipts while disconnected and flushes them after ready", () => {
    socket.connect();
    socket.send({ type: "played", message_id: "m1" });
    socket.send({ type: "ping" }); // pings are not buffered
    sockets[0]!.open();
    expect(sockets[0]!.sent.map((s) => JSON.parse(s).type)).toEqual(["hello"]);
    sockets[0]!.receive({ type: "ready", user_id: 1, latest_seq: 0, online: [] });
    expect(sockets[0]!.sent.map((s) => JSON.parse(s).type)).toEqual(["hello", "played"]);
  });

  it("close() stops reconnecting", () => {
    socket.connect();
    socket.close();
    expect(states.at(-1)).toBe("closed");
    expect(timers).toEqual([]);
  });
});
