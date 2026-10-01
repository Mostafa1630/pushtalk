"""Channel presence stored in Redis.

Each open WebSocket is one entry `"<user_id>:<connection_id>"` in a sorted set
per channel, scored with its expiry timestamp. Heartbeats push the expiry
forward. A user is online while at least one of their connections is alive,
so two tabs or two devices count once, and closing one tab doesn't mark the
user offline. Entries of crashed API processes simply expire.
"""

import time

from redis.asyncio import Redis


def _key(channel_id: int) -> str:
    return f"pushtalk:presence:{channel_id}"


class PresenceStore:
    def __init__(self, redis: Redis, ttl_seconds: int) -> None:
        self.redis = redis
        self.ttl = ttl_seconds

    async def touch(self, channel_id: int, user_id: int, connection_id: str) -> None:
        key = _key(channel_id)
        async with self.redis.pipeline(transaction=True) as pipe:
            pipe.zadd(key, {f"{user_id}:{connection_id}": time.time() + self.ttl})
            pipe.expire(key, self.ttl * 4)
            await pipe.execute()

    async def remove(self, channel_id: int, user_id: int, connection_id: str) -> None:
        await self.redis.zrem(_key(channel_id), f"{user_id}:{connection_id}")

    async def online_user_ids(self, channel_id: int) -> list[int]:
        key = _key(channel_id)
        now = time.time()
        async with self.redis.pipeline(transaction=True) as pipe:
            pipe.zremrangebyscore(key, "-inf", now)
            pipe.zrangebyscore(key, now, "+inf")
            _, members = await pipe.execute()
        return sorted({int(m.split(":", 1)[0]) for m in members})
