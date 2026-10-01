"""Liveness/readiness endpoint used by Docker health checks and humans."""

import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.db.session import SessionLocal

router = APIRouter(tags=["health"])
logger = logging.getLogger("app.health")


@router.get("/health")
async def health(request: Request) -> JSONResponse:
    checks: dict[str, str] = {}
    try:
        async with SessionLocal() as session:
            await session.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception as exc:  # noqa: BLE001 - report any failure as "down"
        logger.warning("health_db_down", extra={"error": type(exc).__name__})
        checks["database"] = "down"
    try:
        await request.app.state.redis.ping()
        checks["redis"] = "ok"
    except Exception as exc:  # noqa: BLE001
        logger.warning("health_redis_down", extra={"error": type(exc).__name__})
        checks["redis"] = "down"

    healthy = all(v == "ok" for v in checks.values())
    return JSONResponse(
        {"status": "ok" if healthy else "degraded", "checks": checks},
        status_code=200 if healthy else 503,
    )
