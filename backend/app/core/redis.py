"""Redis connection helpers shared by the API and the worker."""

from redis.asyncio import Redis

from app.core.config import get_settings


def create_redis(url: str | None = None) -> Redis:
    return Redis.from_url(
        url or get_settings().redis_url,
        decode_responses=True,
        socket_connect_timeout=3,
        health_check_interval=30,
    )
