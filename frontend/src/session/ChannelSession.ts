// Orchestrates one open channel: history, realtime socket, ordering,
// catch-up, uploads, receipts and the playback queue. Plain TypeScript with
// a subscribe/getSnapshot API consumed by React via useSyncExternalStore.

import { ApiError } from "../api/client";
import { channelApi, messageApi } from "../api/endpoints";
import type {
  ClientFrame,
  Member,
  MessageDTO,
  ServerEvent,
} from "../api/types";
import {
  historyCursorBeforePage,
  MessageSequencer,
} from "../messages/MessageSequencer";
import {
  describeErrorCode,
  fromDTO,
  mergeMessage,
  sortMessages,
  type ChatMessage,
} from "../messages/messageModel";
import { acquirePlaybackLeadership } from "../playback/leader";
import {
  nextRate,
  readStoredRate,
  storeRate,
  type PlaybackRate,
} from "../playback/rate";
import { notificationFeed } from "../notifications/NotificationFeed";
import {
  PlaybackQueue,
  type AudioPlayer,
  type QueueItem,
  type QueueSnapshot,
} from "../playback/PlaybackQueue";
import {
  ChannelSocket,
  channelSocketUrl,
  type ConnectionState,
} from "../realtime/ChannelSocket";
import { newClientId } from "./ids";

/** Catch-up messages older than this are shown as "unheard" instead of auto-played. */
export const AUTOPLAY_MAX_AGE_MS = 5 * 60_000;
const GAP_FILL_DELAY_MS = 800;
const HISTORY_LIMIT = 10;
const CATCHUP_PAGE = 200;

export interface SessionState {
  loading: boolean;
  messages: ChatMessage[];
  members: Member[];
  online: number[];
  connection: ConnectionState;
  retryInMs: number | null;
  playback: QueueSnapshot;
  playbackRate: PlaybackRate;
  isLeader: boolean;
  fatalError: string | null;
  notice: string | null;
  /** Reverse pagination: fetching the previous page, and whether one exists. */
  loadingOlder: boolean;
  hasMore: boolean;
}

type Source = "history" | "live" | "catchup";

export class ChannelSession {
  private state: SessionState;
  private readonly listeners = new Set<() => void>();
  private readonly byKey = new Map<string, ChatMessage>();
  private readonly keyById = new Map<string, string>();
  private sequencer = new MessageSequencer<MessageDTO & { seq: number }>();
  private readonly queue: PlaybackQueue;
  private rate: PlaybackRate = readStoredRate();
  private socket: ChannelSocket | null = null;
  private releaseLeadership: () => void = () => {};
  private catchUpRunning = false;
  private catchUpAgain = false;
  /** Oldest ready seq currently held (cursor for the next `before_seq` page). */
  private oldestSeq: number | null = null;
  private loadingOlder = false;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private readonly pendingFrames: ClientFrame[] = [];
  private readonly onBrowserOnline = () => this.socket?.reconnectNow();
  private readonly onFirstGesture = () => this.unlockAudio();

  constructor(
    readonly channelId: number,
    readonly selfUserId: number,
    private readonly getToken: () => string | null,
    private readonly player: AudioPlayer,
  ) {
    this.queue = new PlaybackQueue(player, {
      selfUserId,
      onPlayed: (item) => this.onPlayed(item),
      onError: (item) => this.onPlaybackError(item),
      onChange: (snapshot) => this.set({ playback: snapshot }),
    });
    this.player.setRate(this.rate);
    this.state = {
      loading: true,
      messages: [],
      members: [],
      online: [],
      connection: "connecting",
      retryInMs: null,
      playback: this.queue.snapshot(),
      playbackRate: this.rate,
      isLeader: false,
      fatalError: null,
      notice: null,
      loadingOlder: false,
      hasMore: false,
    };
  }

  // ---- React glue -------------------------------------------------------------
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionState => this.state;

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  // ---- lifecycle ----------------------------------------------------------------
  async start(): Promise<void> {
    // Autoplay policy: without a prior user gesture the browser rejects play().
    // Pause proactively and unlock on the first click/keypress anywhere.
    const activation = (
      navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }
    ).userActivation;
    if (activation && !activation.hasBeenActive) {
      this.queue.setPaused("blocked", true);
      document.addEventListener("pointerdown", this.onFirstGesture, {
        once: true,
      });
      document.addEventListener("keydown", this.onFirstGesture, { once: true });
    }

    this.releaseLeadership = acquirePlaybackLeadership(
      this.channelId,
      (isLeader) => {
        this.queue.setPaused("inactive", !isLeader);
        this.set({ isLeader });
      },
    );
    window.addEventListener("online", this.onBrowserOnline);

    try {
      await Promise.all([this.refreshMembers(), this.loadHistory()]);
    } catch (err) {
      if (this.destroyed) return;
      this.set({
        loading: false,
        fatalError:
          err instanceof ApiError ? err.message : "Could not load the channel.",
      });
      return;
    }
    if (this.destroyed) return;
    this.set({ loading: false });

    this.socket = new ChannelSocket({
      url: channelSocketUrl(this.channelId),
      getToken: this.getToken,
      onEvent: (e) => this.onEvent(e),
      onState: (connection, detail) =>
        this.set({ connection, retryInMs: detail?.retryInMs ?? null }),
      onFatal: (_code, reason) => this.set({ fatalError: reason }),
    });
    this.socket.connect();
  }

  destroy(): void {
    this.destroyed = true;
    this.socket?.close();
    this.queue.clear();
    this.player.stop();
    this.releaseLeadership();
    window.removeEventListener("online", this.onBrowserOnline);
    document.removeEventListener("pointerdown", this.onFirstGesture);
    document.removeEventListener("keydown", this.onFirstGesture);
    if (this.gapTimer) clearTimeout(this.gapTimer);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.listeners.clear();
  }

  // ---- user actions -------------------------------------------------------------
  /** While recording, incoming audio is held (and any current message interrupted). */
  setRecording(on: boolean): void {
    this.queue.setPaused("recording", on);
  }

  unlockAudio(): void {
    this.queue.unlock();
  }

  /** Play a message, or pause/resume it in place when it is already playing. */
  togglePlayback(key: string): void {
    const m = this.byKey.get(key);
    if (!m || m.status !== "ready" || !m.id || m.seq === null) return;
    if (this.state.playback.current?.id === m.id) {
      this.queue.toggleCurrent();
      return;
    }
    this.queue.enqueue({
      id: m.id,
      seq: m.seq,
      senderId: m.senderId,
      durationMs: m.durationMs,
      manual: true,
    });
  }

  /** 1x -> 1.5x -> 2x -> 1x, for whatever plays from now on. */
  cyclePlaybackRate(): void {
    this.rate = nextRate(this.rate);
    storeRate(this.rate);
    this.queue.setRate(this.rate);
    this.set({ playbackRate: this.rate });
  }

  playUnheard(): void {
    for (const m of this.state.messages) {
      if (m.unheard && m.id && m.seq !== null) {
        this.queue.enqueue({
          id: m.id,
          seq: m.seq,
          senderId: m.senderId,
          durationMs: m.durationMs,
        });
      }
    }
  }

  async sendRecording(blob: Blob): Promise<void> {
    const key = newClientId();
    this.upsert({
      key,
      id: null,
      senderId: this.selfUserId,
      senderName: "you",
      senderAvatarUrl: null,
      status: "uploading",
      seq: null,
      durationMs: null,
      waveform: null,
      errorCode: null,
      errorMessage: null,
      transcript: null,
      createdAt: new Date().toISOString(),
      receipts: null,
      playedByMe: false,
      unheard: false,
      blob,
    });
    await this.upload(key, blob);
  }

  async retryUpload(key: string): Promise<void> {
    const m = this.byKey.get(key);
    if (!m?.blob || m.status !== "upload_failed") return;
    this.upsert({ ...m, status: "uploading", errorMessage: null });
    await this.upload(key, m.blob);
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  // ---- uploads ------------------------------------------------------------------
  private async upload(key: string, blob: Blob): Promise<void> {
    try {
      const dto = await messageApi.upload(this.channelId, blob, key);
      this.upsert(fromDTO(dto));
    } catch (err) {
      const m = this.byKey.get(key);
      if (!m) return;
      if (
        err instanceof ApiError &&
        err.status >= 400 &&
        err.status < 500 &&
        err.status !== 408 &&
        err.status !== 429
      ) {
        // Validation error: retrying the same bytes can't succeed.
        this.upsert({
          ...m,
          status: "failed",
          errorCode: err.code,
          errorMessage: err.message,
          blob: undefined,
        });
      } else {
        // Network error / 5xx: keep the audio so the user can retry (idempotent).
        const message =
          err instanceof ApiError ? err.message : "Upload failed.";
        this.upsert({
          ...m,
          status: "upload_failed",
          errorCode: err instanceof ApiError ? err.code : "UPLOAD_FAILED",
          errorMessage: message,
        });
      }
    }
  }

  // ---- history & catch-up ---------------------------------------------------------
  private async loadHistory(): Promise<void> {
    const page = await messageApi.list(this.channelId, {
      limit: HISTORY_LIMIT,
    });
    const ready = page.messages.filter(isReady);
    const oldest = ready[0];
    this.oldestSeq = oldest ? oldest.seq : null;
    this.set({ hasMore: page.has_more });
    this.sequencer = new MessageSequencer(
      historyCursorBeforePage(page.latest_seq, ready),
    );
    this.applyReady(ready, "history");
    for (const dto of page.messages.filter((m) => !isReady(m)))
      this.upsert(fromDTO(dto));
  }

  /** Fetch the page of ready messages older than anything we hold. Single-flight. */
  async loadOlder(): Promise<void> {
    if (this.loadingOlder || this.oldestSeq === null || this.destroyed) return;
    this.loadingOlder = true;
    this.set({ loadingOlder: true });
    try {
      const page = await messageApi.list(this.channelId, {
        beforeSeq: this.oldestSeq,
        limit: HISTORY_LIMIT,
      });
      const ready = page.messages.filter(isReady);
      const oldest = ready[0];
      if (oldest) this.oldestSeq = oldest.seq;
      // Older pages are entirely ready and below the sequencer's floor: apply
      // directly, the same way the first history page is.
      const toAck: string[] = [];
      for (const dto of ready) {
        const fromOther = dto.sender_id !== this.selfUserId;
        this.upsert({
          ...fromDTO(dto),
          unheard: fromOther && !dto.played_by_me,
        });
        if (fromOther) toAck.push(dto.id);
      }
      if (toAck.length > 0) this.socketSend({ type: "ack", delivered: toAck });
      this.set({ hasMore: page.has_more, loadingOlder: false });
    } catch {
      // Transient error: let the user scroll up again to retry.
      this.set({ loadingOlder: false });
    } finally {
      this.loadingOlder = false;
    }
  }

  /** Fetch everything after our last seq, page by page. Single-flight. */
  private async catchUp(): Promise<void> {
    if (this.catchUpRunning) {
      this.catchUpAgain = true;
      return;
    }
    this.catchUpRunning = true;
    try {
      do {
        this.catchUpAgain = false;
        let hasMore = true;
        while (hasMore && !this.destroyed) {
          const page = await messageApi.list(this.channelId, {
            afterSeq: this.sequencer.lastSeq,
            limit: CATCHUP_PAGE,
          });
          this.applyReady(page.messages.filter(isReady), "catchup");
          // Own processing/failed messages may have changed while we were offline.
          for (const dto of page.messages.filter((m) => !isReady(m)))
            this.upsert(fromDTO(dto));
          hasMore = page.has_more;
        }
      } while (this.catchUpAgain && !this.destroyed);
    } catch {
      // Network blip: the next `ready` / gap / resync triggers another attempt.
      this.scheduleGapFill();
    } finally {
      this.catchUpRunning = false;
    }
  }

  private scheduleGapFill(): void {
    if (this.gapTimer || this.destroyed) return;
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      if (this.sequencer.hasGap) void this.catchUp();
    }, GAP_FILL_DELAY_MS);
  }

  private applyReady(
    dtos: (MessageDTO & { seq: number })[],
    source: Source,
  ): void {
    const released = this.sequencer.push(dtos);
    const toAck: string[] = [];
    for (const dto of released) {
      const fromOther = dto.sender_id !== this.selfUserId;
      const age = Date.now() - Date.parse(dto.created_at);
      const autoplay =
        fromOther &&
        !dto.played_by_me &&
        source !== "history" &&
        age < AUTOPLAY_MAX_AGE_MS;
      this.upsert({
        ...fromDTO(dto),
        unheard: fromOther && !dto.played_by_me && !autoplay,
      });
      if (fromOther) toAck.push(dto.id);
      if (autoplay) {
        this.queue.enqueue({
          id: dto.id,
          seq: dto.seq,
          senderId: dto.sender_id,
          durationMs: dto.duration_ms,
        });
      }
    }
    if (toAck.length > 0) {
      // "delivered" = this client received it (live or catch-up). Batched acks.
      for (let i = 0; i < toAck.length; i += 200) {
        this.socketSend({ type: "ack", delivered: toAck.slice(i, i + 200) });
      }
    }
    if (this.sequencer.hasGap) this.scheduleGapFill();
  }

  /** Before the socket exists (history load) frames wait here; afterwards ChannelSocket buffers them. */
  private socketSend(frame: ClientFrame): void {
    if (this.socket) this.socket.send(frame);
    else this.pendingFrames.push(frame);
  }

  // ---- realtime events --------------------------------------------------------------
  private onEvent(event: ServerEvent): void {
    switch (event.type) {
      case "ready":
        this.set({ online: event.online, fatalError: null });
        for (const f of this.pendingFrames.splice(0)) this.socket?.send(f);
        this.syncMembers(event.online);
        if (this.sequencer.isBehind(event.latest_seq)) void this.catchUp();
        break;
      case "message.new":
        if (isReady(event.message)) this.applyReady([event.message], "live");
        break;
      case "message.failed": {
        const key = this.keyById.get(event.message_id) ?? event.client_id;
        const m = this.byKey.get(key);
        if (m && event.sender_id === this.selfUserId) {
          this.upsert({
            ...m,
            id: event.message_id,
            status: "failed",
            errorCode: event.error_code,
            errorMessage: describeErrorCode(event.error_code),
          });
        }
        break;
      }
      case "message.status": {
        const key = this.keyById.get(event.message_id);
        const m = key ? this.byKey.get(key) : undefined;
        if (m && m.senderId === this.selfUserId)
          this.upsert({ ...m, receipts: event.receipts });
        if (event.user_id === this.selfUserId && event.kind === "played") {
          // Played on another tab/device of mine: don't play it here again.
          this.queue.remove(event.message_id);
          if (m) this.upsert({ ...m, playedByMe: true, unheard: false });
        }
        break;
      }
      case "message.transcript": {
        const key = this.keyById.get(event.message_id);
        const m = key ? this.byKey.get(key) : undefined;
        if (m) this.upsert({ ...m, transcript: event.transcript });
        break;
      }
      case "presence":
        this.set({ online: event.online });
        this.syncMembers(event.online);
        break;
      case "notification.new":
        // Per-user push arriving on this channel socket; the bell reads it.
        notificationFeed.receive(event.notification);
        break;
      case "resync":
        void this.catchUp();
        break;
      case "error":
        console.warn("server error frame", event.code, event.message);
        break;
      case "pong":
        break;
    }
  }

  private async refreshMembers(): Promise<void> {
    const members = await channelApi.members(this.channelId);
    this.set({
      members,
      online: members.filter((m) => m.online).map((m) => m.user_id),
    });
  }

  /** Someone new joined and came online: refresh the member list. */
  private syncMembers(online: number[]): void {
    const known = new Set(this.state.members.map((m) => m.user_id));
    if (online.some((id) => !known.has(id)))
      this.refreshMembers().catch(() => undefined);
  }

  // ---- playback callbacks ------------------------------------------------------------
  private onPlayed(item: QueueItem): void {
    const key = this.keyById.get(item.id);
    const m = key ? this.byKey.get(key) : undefined;
    if (m) this.upsert({ ...m, playedByMe: true, unheard: false });
    if (item.senderId !== this.selfUserId)
      this.socketSend({ type: "played", message_id: item.id });
  }

  private onPlaybackError(item: QueueItem): void {
    const key = this.keyById.get(item.id);
    const m = key ? this.byKey.get(key) : undefined;
    this.showNotice(
      `Couldn't play the message from ${m?.senderName ?? "a member"}. Skipped to the next one.`,
    );
    if (m) this.upsert({ ...m, unheard: true });
  }

  private showNotice(notice: string): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.set({ notice });
    this.noticeTimer = setTimeout(() => this.set({ notice: null }), 6000);
  }

  // ---- state helpers ----------------------------------------------------------------
  private upsert(update: ChatMessage): void {
    const key = (update.id && this.keyById.get(update.id)) || update.key;
    const merged = mergeMessage(this.byKey.get(key), { ...update, key });
    this.byKey.set(key, merged);
    if (merged.id) this.keyById.set(merged.id, key);
    this.set({ messages: sortMessages(this.byKey.values()) });
  }
}

function isReady(m: MessageDTO): m is MessageDTO & { seq: number } {
  return m.status === "ready" && m.seq !== null;
}
