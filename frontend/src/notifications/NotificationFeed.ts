// Global notification feed behind the top-bar bell: unread badge plus a
// paginated, newest-first list. Plain TypeScript with a subscribe/getSnapshot
// API consumed by React via useSyncExternalStore — the same pattern as
// ChannelSession. The server stays the source of truth: every dropdown open
// refetches the first page, realtime notification.new events only top it up.

import { notificationApi } from "../api/endpoints";
import type { NotificationDTO, NotificationPage, UnreadCount } from "../api/types";

const PAGE_LIMIT = 10;

export interface FeedState {
  unreadCount: number;
  /** True once the first page has been fetched (even if it came back empty). */
  loaded: boolean;
  /** Last first-page fetch failed; the list shows an error instead. */
  error: boolean;
  items: NotificationDTO[];
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
}

const INITIAL: FeedState = {
  unreadCount: 0,
  loaded: false,
  error: false,
  items: [],
  hasMore: false,
  loading: false,
  loadingMore: false,
};

export interface NotificationEndpoints {
  list(params: { beforeId?: number; limit?: number }): Promise<NotificationPage>;
  unreadCount(): Promise<UnreadCount>;
  markRead(id: number): Promise<NotificationDTO>;
  markAllRead(): Promise<UnreadCount>;
}

export class NotificationFeed {
  private state: FeedState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private active = false;
  /** Oldest id currently held (cursor for the next `before_id` page). */
  private oldestId: number | null = null;
  /** Bumped by stop() and open(); responses from stale calls are discarded. */
  private epoch = 0;
  /** Pushes already applied (dup delivery must not double-count the badge). */
  private readonly seenIds = new Set<number>();

  constructor(private readonly api: NotificationEndpoints) {}

  // ---- React glue ------------------------------------------------------------
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): FeedState => this.state;

  private set(patch: Partial<FeedState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  // ---- lifecycle ----------------------------------------------------------------
  /** Called when a user session appears; fetches the badge count. Idempotent. */
  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    await this.refreshCount();
  }

  /** Called on logout: drop everything so the next user starts clean. */
  stop(): void {
    this.active = false;
    this.epoch++;
    this.oldestId = null;
    this.seenIds.clear();
    this.state = INITIAL;
    this.listeners.forEach((l) => l());
  }

  /** Re-sync just the badge (tab focus, after failed mutations). */
  async refreshCount(): Promise<void> {
    if (!this.active) return;
    try {
      const { count } = await this.api.unreadCount();
      if (this.active) this.set({ unreadCount: count });
    } catch {
      // Keep the last known count; the next open()/focus retries.
    }
  }

  /** The dropdown opened: refetch the first page and the count, fresh. */
  async open(): Promise<void> {
    if (!this.active) return;
    const myEpoch = ++this.epoch;
    this.set({ loading: true, error: false });
    try {
      const [page, count] = await Promise.all([
        this.api.list({ limit: PAGE_LIMIT }),
        this.api.unreadCount(),
      ]);
      if (myEpoch !== this.epoch) return;
      this.oldestId = page.notifications.at(-1)?.id ?? null;
      this.set({
        unreadCount: count.count,
        items: page.notifications,
        hasMore: page.has_more,
        loaded: true,
        loading: false,
      });
    } catch {
      if (myEpoch !== this.epoch) return;
      this.set({ loading: false, error: true });
    }
  }

  /** Fetch the page older than everything we hold. Single-flight. */
  async loadMore(): Promise<void> {
    if (
      !this.active ||
      !this.state.loaded ||
      this.state.loadingMore ||
      !this.state.hasMore ||
      this.oldestId === null
    )
      return;
    const myEpoch = this.epoch;
    this.set({ loadingMore: true });
    try {
      const page = await this.api.list({
        beforeId: this.oldestId,
        limit: PAGE_LIMIT,
      });
      if (myEpoch !== this.epoch) return;
      // Newer ids can only arrive via receive(), which prepends — so the
      // older page never overlaps what we already hold.
      this.oldestId = page.notifications.at(-1)?.id ?? null;
      this.set({
        items: [...this.state.items, ...page.notifications],
        hasMore: page.has_more,
        loadingMore: false,
      });
    } catch {
      if (myEpoch !== this.epoch) return;
      // Transient error: the user can scroll down again to retry.
      this.set({ loadingMore: false });
    }
  }

  // ---- realtime ----------------------------------------------------------------
  /** A notification.new event arrived on any open channel socket. */
  receive(dto: NotificationDTO): void {
    if (!this.active || this.seenIds.has(dto.id)) return;
    this.seenIds.add(dto.id);
    this.set({
      unreadCount: dto.is_read
        ? this.state.unreadCount
        : this.state.unreadCount + 1,
      items: this.state.loaded ? [dto, ...this.state.items] : this.state.items,
    });
  }

  // ---- mutations (optimistic, reverted on failure) --------------------------------
  async markRead(id: number): Promise<void> {
    const item = this.state.items.find((n) => n.id === id);
    if (!item || item.is_read) return;
    this.set({
      items: this.state.items.map((n) =>
        n.id === id ? { ...n, is_read: true } : n,
      ),
      unreadCount: Math.max(0, this.state.unreadCount - 1),
    });
    try {
      await this.api.markRead(id);
    } catch {
      this.set({
        items: this.state.items.map((n) =>
          n.id === id ? { ...n, is_read: false } : n,
        ),
      });
      await this.refreshCount();
    }
  }

  async markAllRead(): Promise<void> {
    const flipped = this.state.items.filter((n) => !n.is_read);
    if (flipped.length === 0 && this.state.unreadCount === 0) return;
    this.set({
      items: this.state.items.map((n) => ({ ...n, is_read: true })),
      unreadCount: 0,
    });
    try {
      await this.api.markAllRead();
    } catch {
      const ids = new Set(flipped.map((n) => n.id));
      this.set({
        items: this.state.items.map((n) =>
          ids.has(n.id) ? { ...n, is_read: false } : n,
        ),
      });
      await this.refreshCount();
    }
  }
}

export const notificationFeed = new NotificationFeed(notificationApi);
