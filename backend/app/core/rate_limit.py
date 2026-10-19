"""Per-user and per-IP rate limiting backed by Redis.

Limits are applied on a fixed/sliding window:
- Authenticated requests are keyed by `user:{user_id}`.
- Unauthenticated requests are keyed by `ip:{client_ip}`.
- Expensive upload endpoints have their own lower quota to protect CPU/worker resources.
"""

import logging
import re
from typing import Any

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from redis.asyncio import Redis

from app.core.config import Settings
from app.core.errors import error_body
from app.core.security import decode_access_token

logger = logging.getLogger("app.ratelimit")

UPLOAD_PATH_RE = re.compile(
    r"^/api/(channels/\d+/messages|channels/\d+/image|users/avatar)$"
)


def extract_client_identifier(request: Request) -> str:
    """Extract authenticated user ID or fall back to client IP address."""
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        token = auth_header[7:].strip()
        try:
            user_id = decode_access_token(token)
            return f"user:{user_id}"
        except Exception:
            pass

    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        ip = forwarded.split(",")[0].strip()
        if ip:
            return f"ip:{ip}"

    host = request.client.host if request.client else "unknown"
    return f"ip:{host}"


async def check_rate_limit(
    redis: Redis, key: str, limit: int, window: int
) -> tuple[bool, int, int]:
    """Check rate limit for `key`.

    Returns (allowed: bool, remaining: int, retry_after: int).
    """
    try:
        current = await redis.incr(key)
        if current == 1:
            await redis.expire(key, window)
        ttl = await redis.ttl(key)
        if ttl < 0:
            await redis.expire(key, window)
            ttl = window

        remaining = max(0, limit - current)
        allowed = current <= limit
        retry_after = max(1, ttl) if not allowed else 0
        return allowed, remaining, retry_after
    except Exception as exc:
        # If Redis is temporarily down, fail open so users aren't locked out.
        logger.warning("rate_limit_redis_error", extra={"error": type(exc).__name__})
        return True, limit, 0


async def rate_limit_middleware(
    request: Request, call_next: Any, settings: Settings
) -> Response:
    if not settings.rate_limit_enabled:
        return await call_next(request)

    path = request.url.path
    # Skip preflight OPTIONS, healthcheck and WebSocket upgrades
    if request.method == "OPTIONS" or path == "/api/health" or path.endswith("/ws"):
        return await call_next(request)

    # Determine if this is an upload endpoint with tighter limits
    is_upload = request.method == "POST" and bool(UPLOAD_PATH_RE.match(path))
    limit = settings.upload_limit_requests if is_upload else settings.rate_limit_requests
    window = (
        settings.upload_limit_window_seconds
        if is_upload
        else settings.rate_limit_window_seconds
    )
    bucket_type = "upload" if is_upload else "general"

    identifier = extract_client_identifier(request)
    cache_key = f"pushtalk:rate:{bucket_type}:{identifier}"

    redis: Redis | None = getattr(request.app.state, "redis", None)
    if not redis:
        return await call_next(request)

    allowed, remaining, retry_after = await check_rate_limit(
        redis, cache_key, limit, window
    )

    if not allowed:
        logger.warning(
            "rate_limited",
            extra={
                "identifier": identifier,
                "path": path,
                "limit": limit,
                "retry_after": retry_after,
            },
        )
        headers = {
            "Retry-After": str(retry_after),
            "X-RateLimit-Limit": str(limit),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": str(retry_after),
        }
        return JSONResponse(
            error_body(
                "RATE_LIMITED",
                f"Too many requests. Please try again in {retry_after} seconds.",
                {"retry_after": retry_after},
            ),
            status_code=429,
            headers=headers,
        )

    response = await call_next(request)
    response.headers["X-RateLimit-Limit"] = str(limit)
    response.headers["X-RateLimit-Remaining"] = str(remaining)
    response.headers["X-RateLimit-Reset"] = str(retry_after)
    return response
