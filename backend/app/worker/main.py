"""arq worker entrypoint: `arq app.worker.main.WorkerSettings`."""

import logging
from typing import Any

from arq import cron
from arq.connections import RedisSettings
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.config import get_settings
from app.core.logging import configure_logging
from app.db.session import create_engine
from app.services.job_queue import PROCESS_MESSAGE_JOB
from app.storage.local import LocalStorage
from app.worker.tasks import MAX_TRIES, process_message, sweep_stale_messages

logger = logging.getLogger("app.worker")
settings = get_settings()


async def startup(ctx: dict[str, Any]) -> None:
    configure_logging(settings.log_level)
    engine = create_engine()
    ctx["engine"] = engine
    ctx["settings"] = settings
    ctx["session_factory"] = async_sessionmaker(engine, expire_on_commit=False)
    ctx["storage"] = LocalStorage(settings.media_root)
    logger.info("worker_started", extra={"max_jobs": settings.worker_max_jobs})


async def shutdown(ctx: dict[str, Any]) -> None:
    await ctx["engine"].dispose()
    logger.info("worker_stopped")


class WorkerSettings:
    functions = [process_message]
    cron_jobs = [cron(sweep_stale_messages, second={0, 30}, run_at_startup=True)]
    on_startup = startup
    on_shutdown = shutdown
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    max_jobs = settings.worker_max_jobs
    max_tries = MAX_TRIES
    # ffmpeg runs three times per job, plus the bounded ordering wait.
    job_timeout = int(settings.ffmpeg_timeout_seconds * 3 + settings.ordering_wait_seconds + 15)
    keep_result = 60
    health_check_interval = 30


assert process_message.__name__ == PROCESS_MESSAGE_JOB  # enqueue name must match
