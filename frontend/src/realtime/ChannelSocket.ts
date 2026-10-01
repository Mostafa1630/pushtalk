// One WebSocket per open channel, with authentication, heartbeat,
// automatic reconnect (exponential backoff + jitter) and an outbox for
// acks that were produced while disconnected.

import type { ClientFrame, ServerEvent } from "../api/types";
import { backoffDelay } from "./backoff";

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

/** Close codes the server uses for "don't retry" (see backend app/api/routes/ws.py). */
export const FATAL_CLOSE_CODES: Record<number, string> = {
  4400: "Protocol error",
  4401: "Your session expired. Please log in again.",
  4403: "You are not a member of this channel.",
  4404: "This channel does not exist.",
};

const HEARTBEAT_MS = 15_000;
const WS_OPEN = 1; // WebSocket.OPEN (avoids depending on the global in tests)

export interface ChannelSocketOptions {
  url: string;
  getToken: () => string | null;
  onEvent: (event: ServerEvent) => void;
  onState: (state: ConnectionState, detail?: { attempt: number; retryInMs?: number }) => void;
  onFatal: (code: number, reason: string) => void;
  // Injectables (tests)
  createSocket?: (url: string) => WebSocket;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
}

export function channelSocketUrl(channelId: number): string {
  const explicit = import.meta.env.VITE_WS_URL as string | undefined;
  if (explicit) return `${explicit.replace(/\/$/, "")}/ws/channels/${channelId}`;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/api/ws/channels/${channelId}`;
}

export class ChannelSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private ready = false;
  private reconnectTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private outbox: ClientFrame[] = [];
  private readonly opts: Required<Omit<ChannelSocketOptions, "random">> & { random?: () => number };

  constructor(options: ChannelSocketOptions) {
    this.opts = {
      createSocket: (url) => new WebSocket(url),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...options,
    };
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  /** Permanently close (component unmount / logout). */
  close(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close(1000, "client closing");
      this.ws = null;
    }
    this.opts.onState("closed");
  }

  /** Reconnect now (e.g. browser went back online) instead of waiting for backoff. */
  reconnectNow(): void {
    if (this.stopped || this.ready) return;
    if (this.reconnectTimer !== null) {
      this.opts.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
      this.open();
    }
  }

  /** Receipts are buffered while disconnected and flushed after `ready`. */
  send(frame: ClientFrame): void {
    if (this.ready && this.ws?.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(frame));
    } else if (frame.type === "ack" || frame.type === "played") {
      this.outbox.push(frame);
    }
  }

  private open(): void {
    this.ready = false;
    this.opts.onState(this.attempt === 0 ? "connecting" : "reconnecting", { attempt: this.attempt });
    let ws: WebSocket;
    try {
      ws = this.opts.createSocket(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      const token = this.opts.getToken();
      if (!token) {
        this.opts.onFatal(4401, FATAL_CLOSE_CODES[4401]!);
        this.close();
        return;
      }
      ws.send(JSON.stringify({ type: "hello", token } satisfies ClientFrame));
    };

    ws.onmessage = (msg) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(String(msg.data)) as ServerEvent;
      } catch {
        return; // ignore malformed frames
      }
      if (event.type === "ready") {
        this.ready = true;
        this.attempt = 0; // successful connection resets the backoff
        this.opts.onState("open");
        this.startHeartbeat();
        this.flushOutbox();
      }
      this.opts.onEvent(event);
    };

    ws.onclose = (ev) => {
      this.ready = false;
      this.stopHeartbeat();
      this.ws = null;
      if (this.stopped) return;
      const fatal = FATAL_CLOSE_CODES[ev.code];
      if (fatal) {
        this.stopped = true;
        this.opts.onFatal(ev.code, fatal);
        this.opts.onState("closed");
        return;
      }
      this.scheduleReconnect();
    };

    // onerror is always followed by onclose; reconnect logic lives there.
    ws.onerror = () => {};
  }

  private scheduleReconnect(): void {
    const delay = backoffDelay(this.attempt, { random: this.opts.random });
    this.attempt += 1;
    this.opts.onState("reconnecting", { attempt: this.attempt, retryInMs: delay });
    this.reconnectTimer = this.opts.setTimer(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  private flushOutbox(): void {
    const pending = this.outbox;
    this.outbox = [];
    for (const frame of pending) this.send(frame);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const beat = () => {
      this.send({ type: "ping" });
      this.heartbeatTimer = this.opts.setTimer(beat, HEARTBEAT_MS);
    };
    this.heartbeatTimer = this.opts.setTimer(beat, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) this.opts.clearTimer(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) this.opts.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
