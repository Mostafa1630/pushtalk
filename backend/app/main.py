"""FastAPI application factory and startup/shutdown wiring."""

import logging
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from arq import create_pool
from arq.connections import RedisSettings
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import auth, channels, health, media, messages, users, ws
from app.core.config import get_settings
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging, request_id_var
from app.core.redis import create_redis
from app.db.session import engine
from app.realtime.hub import RealtimeHub
from app.storage.local import LocalStorage

logger = logging.getLogger("app")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    app.state.redis = create_redis()
    # arq pool used to enqueue background jobs. Creation fails fast if Redis is
    # down at startup; Docker restarts the container until Redis is healthy.
    app.state.job_queue = await create_pool(RedisSettings.from_dsn(settings.redis_url))
    app.state.storage = LocalStorage(settings.media_root)
    app.state.hub = RealtimeHub(app.state.redis)
    await app.state.hub.start()
    logger.info("startup_complete", extra={"env": settings.app_env})
    try:
        yield
    finally:
        await app.state.hub.stop()
        await app.state.job_queue.aclose()
        await app.state.redis.aclose()
        await engine.dispose()
        logger.info("shutdown_complete")


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)

    app = FastAPI(title="PushTalk API", version="1.0.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
    )

    @app.middleware("http")
    async def request_context(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:16]
        token = request_id_var.set(request_id)
        started = time.perf_counter()
        try:
            response = await call_next(request)
        finally:
            request_id_var.reset(token)
        elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
        response.headers["X-Request-ID"] = request_id
        logger.info(
            "http_request",
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "duration_ms": elapsed_ms,
            },
        )
        return response

    register_exception_handlers(app)

    api_prefix = "/api"
    app.include_router(health.router, prefix=api_prefix)
    app.include_router(auth.router, prefix=api_prefix)
    app.include_router(users.router, prefix=api_prefix)
    app.include_router(channels.router, prefix=api_prefix)
    app.include_router(messages.router, prefix=api_prefix)
    app.include_router(media.router, prefix=api_prefix)
    app.include_router(ws.router, prefix=api_prefix)
    return app


app = create_app()
