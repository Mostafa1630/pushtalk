import { describe, expect, it, vi } from "vitest";
import {
  NotificationFeed,
  type NotificationEndpoints,
} from "./NotificationFeed";
import type { NotificationDTO, NotificationPage } from "../api/types";

function dto(id: number, over: Partial<NotificationDTO> = {}): NotificationDTO {
  return {
    id,
    type: "channel_message",
    title: "New voice message",
    body: "New voice message in #team from bob.",
    related_id: 7,
    channel_name: "team",
    actor_username: "bob",
    is_read: false,
    created_at: "2026-10-04T10:00:00+00:00",
    ...over,
  };
}

function makeApi() {
  return {
    list: vi.fn<NotificationEndpoints["list"]>(),
    unreadCount: vi.fn<NotificationEndpoints["unreadCount"]>(),
    markRead: vi.fn<NotificationEndpoints["markRead"]>(),
    markAllRead: vi.fn<NotificationEndpoints["markAllRead"]>(),
  };
}

/** start() the feed with a given server count. */
async function startedFeed(count = 0) {
  const api = makeApi();
  api.unreadCount.mockResolvedValue({ count });
  const feed = new NotificationFeed(api);
  await feed.start();
  return { api, feed };
}

describe("NotificationFeed", () => {
  it("start() fetches the badge count once; receive() bumps it before the list loads", async () => {
    const { api, feed } = await startedFeed(0);
    expect(feed.getSnapshot().unreadCount).toBe(0);
    expect(api.unreadCount).toHaveBeenCalledTimes(1);

    feed.receive(dto(1));
    feed.receive(dto(2));
    const state = feed.getSnapshot();
    expect(state.unreadCount).toBe(2);
    expect(state.items).toEqual([]); // list not loaded yet
  });

  it("receive() is ignored while stopped and dedupes by id", async () => {
    const { feed } = await startedFeed(0);
    feed.stop();
    feed.receive(dto(1));
    expect(feed.getSnapshot().unreadCount).toBe(0);

    await feed.start();
    feed.receive(dto(1));
    feed.receive(dto(1)); // same id twice (e.g. two sockets)
    expect(feed.getSnapshot().unreadCount).toBe(1);
  });

  it("open() loads the first page newest-first and the count", async () => {
    const { api, feed } = await startedFeed(0);
    const page: NotificationPage = {
      notifications: [dto(3), dto(2, { is_read: true })],
      has_more: true,
    };
    api.list.mockResolvedValueOnce(page);
    api.unreadCount.mockResolvedValueOnce({ count: 5 });

    await feed.open();
    const state = feed.getSnapshot();
    expect(state.loaded).toBe(true);
    expect(state.items).toEqual(page.notifications);
    expect(state.hasMore).toBe(true);
    expect(state.unreadCount).toBe(5);
    expect(api.list).toHaveBeenCalledWith({ limit: 10 });
  });

  it("a failed open() sets the error flag without pretending to be loaded", async () => {
    const { api, feed } = await startedFeed(2);
    api.list.mockRejectedValueOnce(new Error("boom"));

    await feed.open();
    const state = feed.getSnapshot();
    expect(state.error).toBe(true);
    expect(state.loaded).toBe(false);
    expect(state.unreadCount).toBe(2); // count untouched
  });

  it("receive() prepends to a loaded list; open() replaces it fresh", async () => {
    const { api, feed } = await startedFeed(0);
    api.list.mockResolvedValueOnce({ notifications: [dto(2)], has_more: false });
    api.unreadCount.mockResolvedValueOnce({ count: 0 });
    await feed.open();

    feed.receive(dto(5));
    expect(feed.getSnapshot().items.map((n) => n.id)).toEqual([5, 2]);

    api.list.mockResolvedValueOnce({ notifications: [dto(4), dto(2)], has_more: false });
    api.unreadCount.mockResolvedValueOnce({ count: 1 });
    await feed.open();
    expect(feed.getSnapshot().items.map((n) => n.id)).toEqual([4, 2]);
  });

  it("loadMore() appends the older page once and follows has_more to the end", async () => {
    const { api, feed } = await startedFeed(0);
    api.list.mockResolvedValueOnce({ notifications: [dto(3)], has_more: true });
    api.unreadCount.mockResolvedValueOnce({ count: 0 });
    await feed.open();

    let resolveFirst!: (p: NotificationPage) => void;
    api.list.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveFirst = res;
        }),
    );
    const first = feed.loadMore();
    const second = feed.loadMore(); // single-flight: no second request
    expect(api.list).toHaveBeenCalledTimes(2);
    resolveFirst({ notifications: [dto(2), dto(1)], has_more: false });
    await Promise.all([first, second]);
    expect(feed.getSnapshot().items.map((n) => n.id)).toEqual([3, 2, 1]);

    await feed.loadMore(); // has_more false: nothing to do
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it("loadMore() requests the page strictly before the oldest held id", async () => {
    const { api, feed } = await startedFeed(0);
    api.list.mockResolvedValueOnce({ notifications: [dto(7), dto(5)], has_more: true });
    api.unreadCount.mockResolvedValueOnce({ count: 0 });
    await feed.open();

    api.list.mockResolvedValueOnce({ notifications: [dto(4)], has_more: false });
    await feed.loadMore();
    expect(api.list).toHaveBeenLastCalledWith({ beforeId: 5, limit: 10 });
  });

  it("markRead() optimistically reads one and decrements; failure reverts via re-sync", async () => {
    const { api, feed } = await startedFeed(2);
    api.list.mockResolvedValueOnce({
      notifications: [dto(1), dto(2, { is_read: true })],
      has_more: false,
    });
    api.unreadCount.mockResolvedValueOnce({ count: 2 });
    await feed.open();

    api.markRead.mockResolvedValueOnce(dto(1, { is_read: true }));
    await feed.markRead(1);
    let state = feed.getSnapshot();
    expect(state.items[0]?.is_read).toBe(true);
    expect(state.unreadCount).toBe(1);

    await feed.markRead(2); // already read: no-op, no request
    expect(api.markRead).toHaveBeenCalledTimes(1);

    // A fresh unread push whose read request fails must roll back.
    feed.receive(dto(3));
    api.markRead.mockRejectedValueOnce(new Error("boom"));
    api.unreadCount.mockResolvedValueOnce({ count: 2 }); // server truth after failure
    await feed.markRead(3);
    state = feed.getSnapshot();
    expect(state.items[0]?.is_read).toBe(false);
    expect(state.unreadCount).toBe(2);
  });

  it("markAllRead() clears everything; failure reverts the flipped rows", async () => {
    const { api, feed } = await startedFeed(2);
    api.list.mockResolvedValueOnce({
      notifications: [dto(1), dto(2, { is_read: true })],
      has_more: false,
    });
    api.unreadCount.mockResolvedValueOnce({ count: 1 });
    await feed.open();

    api.markAllRead.mockResolvedValueOnce({ count: 1 });
    await feed.markAllRead();
    let state = feed.getSnapshot();
    expect(state.unreadCount).toBe(0);
    expect(state.items.every((n) => n.is_read)).toBe(true);

    // Back to unread state, then a failing read-all.
    api.list.mockResolvedValueOnce({
      notifications: [dto(1), dto(2, { is_read: true })],
      has_more: false,
    });
    api.unreadCount.mockResolvedValueOnce({ count: 1 });
    await feed.open();
    api.markAllRead.mockRejectedValueOnce(new Error("boom"));
    api.unreadCount.mockResolvedValueOnce({ count: 1 });
    await feed.markAllRead();
    state = feed.getSnapshot();
    expect(state.items.map((n) => n.is_read)).toEqual([false, true]);
    expect(state.unreadCount).toBe(1);
  });

  it("stop() resets state and discards an in-flight open()", async () => {
    const { api, feed } = await startedFeed(1);
    let resolveList!: (p: NotificationPage) => void;
    api.list.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveList = res;
        }),
    );
    api.unreadCount.mockResolvedValueOnce({ count: 1 });
    const opening = feed.open();
    feed.stop();
    resolveList({ notifications: [dto(9)], has_more: false });
    await opening;

    const state = feed.getSnapshot();
    expect(state.loaded).toBe(false);
    expect(state.items).toEqual([]);
    expect(state.unreadCount).toBe(0);
  });
});
