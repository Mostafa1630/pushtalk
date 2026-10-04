"""Per-process fan-out from Redis pub/sub to local WebSocket connections.

One API process holds ONE Redis pattern subscription (`pushtalk:channel:*`)
instead of one subscription per socket. Incoming events are pushed into each
local connection's bounded outbox; a dedicated writer task per connection
drains it, so one slow client can never block the others.

If the Redis subscription drops, the hub reconnects with backoff and then
tells every local client to `resync` (re-fetch after its last seq), because
anything published during the outage was lost by pub/sub.
"""

import asyncio
import json
import logging
from collections import defaultdict
from typing import Any

from redis.asyncio import Redis

from app.realtime.events import CHANNEL_TOPIC_PREFIX, EVT_RESYNC, USER_TOPIC_PREFIX

logger = logging.getLogger("app.realtime.hub")

OUTBOX_SIZE = 256


class ClientConnection:
    """A registered WebSocket as seen by the hub: just an outbox."""

    def __init__(self, connection_id: str, channel_id: int, user_id: int) -> None:
        self.connection_id = connection_id
        self.channel_id = channel_id
        self.user_id = user_id
        self.outbox: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=OUTBOX_SIZE)
        self.overflowed = False

    def offer(self, event: dict[str, Any]) -> None:
        try:
            self.outbox.put_nowait(event)
        except asyncio.QueueFull:
            # The client is too slow. Close it; it reconnects and catches up.
            self.overflowed = True
            self.close()

    def close(self) -> None:
        try:
            self.outbox.put_nowait(None)  # sentinel: writer stops and closes the socket
        except asyncio.QueueFull:
            pass


class RealtimeHub:
    def __init__(self, redis: Redis) -> None:
        self.redis = redis
        self._connections: dict[int, set[ClientConnection]] = defaultdict(set)
        # Same connections indexed by user: user-level events (notifications)
        # must reach every socket a user has open, whatever channel it is on.
        self._user_connections: dict[int, set[ClientConnection]] = defaultdict(set)
        self._task: asyncio.Task[None] | None = None
        self._subscribed = asyncio.Event()

    @property
    def healthy(self) -> bool:
        return self._subscribed.is_set()

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="realtime-hub")
        # Give the first subscription a moment so early sockets aren't refused.
        try:
            await asyncio.wait_for(self._subscribed.wait(), timeout=3)
        except TimeoutError:
            logger.warning("hub_not_subscribed_at_startup")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        for conns in self._connections.values():
            for conn in conns:
                conn.close()

    def register(self, conn: ClientConnection) -> None:
        self._connections[conn.channel_id].add(conn)
        self._user_connections[conn.user_id].add(conn)

    def unregister(self, conn: ClientConnection) -> None:
        conns = self._connections.get(conn.channel_id)
        if conns is not None:
            conns.discard(conn)
            if not conns:
                del self._connections[conn.channel_id]
        user_conns = self._user_connections.get(conn.user_id)
        if user_conns is not None:
            user_conns.discard(conn)
            if not user_conns:
                del self._user_connections[conn.user_id]

    def connection_count(self) -> int:
        return sum(len(c) for c in self._connections.values())

    def _dispatch(self, channel_id: int, event: dict[str, Any]) -> None:
        for conn in list(self._connections.get(channel_id, ())):
            conn.offer(event)

    def _dispatch_user(self, user_id: int, event: dict[str, Any]) -> None:
        for conn in list(self._user_connections.get(user_id, ())):
            conn.offer(event)

    def _broadcast_resync(self) -> None:
        for channel_id in list(self._connections):
            self._dispatch(channel_id, {"type": EVT_RESYNC})

    async def _run(self) -> None:
        backoff = 0.5
        had_failure = False
        while True:
            pubsub = self.redis.pubsub(ignore_subscribe_messages=True)
            try:
                await pubsub.psubscribe(f"{CHANNEL_TOPIC_PREFIX}*", f"{USER_TOPIC_PREFIX}*")
                self._subscribed.set()
                logger.info("hub_subscribed", extra={"recovered": had_failure})
                if had_failure:
                    self._broadcast_resync()
                backoff = 0.5
                async for raw in pubsub.listen():
                    if raw.get("type") != "pmessage":
                        continue
                    topic = str(raw["channel"])
                    try:
                        event = json.loads(raw["data"])
                        if topic.startswith(USER_TOPIC_PREFIX):
                            self._dispatch_user(int(topic.removeprefix(USER_TOPIC_PREFIX)), event)
                        else:
                            self._dispatch(int(topic.removeprefix(CHANNEL_TOPIC_PREFIX)), event)
                    except (ValueError, TypeError, json.JSONDecodeError):
                        logger.warning("hub_bad_payload")
                        continue
            except asyncio.CancelledError:
                await pubsub.aclose()
                raise
            except Exception as exc:  # noqa: BLE001 - keep the hub alive through Redis outages
                self._subscribed.clear()
                had_failure = True
                logger.error(
                    "hub_subscription_lost",
                    extra={"error": type(exc).__name__, "retry_in_s": backoff},
                )
                try:
                    await pubsub.aclose()
                except Exception:  # noqa: BLE001
                    pass
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 10)
