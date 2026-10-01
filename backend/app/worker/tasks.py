"""Background jobs: audio processing and the stale-message sweeper.

process_message(message_id)
    1. load the message (must still be `processing`; otherwise it's a duplicate run)
    2. ffmpeg: normalize to mono 48 kHz Opus/OGG (loudness normalized, hard 60 s cap)
    3. measure the REAL duration of the normalized file and extract waveform peaks
    4. wait until no OLDER message of the same channel is still processing
       (so broadcast order == upload order), bounded by ORDERING_WAIT_SECONDS
    5. in one transaction: lock the channel row, take next seq, mark `ready`
    6. only after commit: publish `message.new` to the channel via Redis

Permanent failures (bad audio, ffmpeg error/timeout, storage error) mark the
message `failed` and publish `message.failed` so the sender's UI updates.
Transient failures (database / Redis unreachable) are retried by arq with a
delay; on the final attempt the message is marked failed.
"""

import asyncio
import logging
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from arq import Retry
from redis.exceptions import ConnectionError as RedisConnectionError
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.audio import ffmpeg
from app.core.config import Settings
from app.models import Message, MessageStatus, User
from app.realtime import events
from app.repositories.channels import ChannelRepository
from app.repositories.messages import MessageRepository
from app.services.message_service import to_out
from app.storage.local import LocalStorage, StorageError

logger = logging.getLogger("app.worker")

MAX_TRIES = 3
ORDERING_POLL_SECONDS = 0.25
TRANSIENT_ERRORS = (DBAPIError, RedisConnectionError, ConnectionError)


class ProcessingFailed(Exception):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code


def _deps(ctx: dict[str, Any]) -> tuple[Settings, async_sessionmaker[AsyncSession], LocalStorage]:
    return ctx["settings"], ctx["session_factory"], ctx["storage"]


async def process_message(ctx: dict[str, Any], message_id: str) -> str:
    settings, session_factory, storage = _deps(ctx)
    mid = uuid.UUID(message_id)
    job_try: int = ctx.get("job_try", 1)
    log = {"message_id": message_id, "job_try": job_try}

    try:
        async with session_factory() as session:
            message = await session.get(Message, mid)
            if message is None or message.status != MessageStatus.PROCESSING.value:
                logger.info("job_skipped", extra={**log, "status": getattr(message, "status", None)})
                return "skipped"
            upload_path = storage.path_for(message.upload_path)
            audio_key = storage.audio_key(mid)
            channel_id = message.channel_id

        started = asyncio.get_running_loop().time()
        waveform, duration_ms = await _transcode(settings, upload_path, storage.path_for(audio_key))
        await _wait_for_older_messages(settings, session_factory, mid)
        seq = await _mark_ready(session_factory, mid, audio_key, duration_ms, waveform)
        if seq is None:  # swept as stale while we were working
            storage.delete(audio_key)
            return "skipped"
    except ProcessingFailed as exc:
        logger.warning("processing_failed", extra={**log, "code": exc.code, "detail": str(exc)[:300]})
        await _mark_failed(ctx, mid, exc.code)
        return "failed"
    except TRANSIENT_ERRORS as exc:
        if job_try < MAX_TRIES:
            logger.warning("processing_retry", extra={**log, "error": type(exc).__name__})
            raise Retry(defer=2 * job_try) from exc
        logger.error("processing_gave_up", extra={**log, "error": type(exc).__name__})
        await _mark_failed(ctx, mid, "PROCESSING_ERROR")
        return "failed"

    # Raw upload is no longer needed once the normalized file is committed.
    _safe_delete(storage, storage.upload_key(mid))
    await _publish_ready(ctx, mid, channel_id)
    logger.info(
        "processing_succeeded",
        extra={
            **log,
            "channel_id": channel_id,
            "seq": seq,
            "duration_ms": duration_ms,
            "elapsed_ms": round((asyncio.get_running_loop().time() - started) * 1000),
        },
    )
    return "ready"


async def _transcode(settings: Settings, src: Path, dst: Path) -> tuple[list[float], int]:
    if not src.is_file():
        raise ProcessingFailed("UPLOAD_MISSING", f"Upload file not found: {src.name}")
    try:
        await ffmpeg.normalize_to_opus(
            src, dst, max_seconds=settings.max_audio_seconds, timeout=settings.ffmpeg_timeout_seconds
        )
        probe = await ffmpeg.probe(
            dst, max_seconds=settings.max_audio_seconds + 1, timeout=settings.ffmpeg_timeout_seconds
        )
        peaks = await ffmpeg.waveform_peaks(
            dst, buckets=settings.waveform_peaks, timeout=settings.ffmpeg_timeout_seconds
        )
    except ffmpeg.AudioError as exc:
        dst.unlink(missing_ok=True)
        raise ProcessingFailed(exc.code, str(exc)) from exc
    except OSError as exc:  # disk full, permissions, volume missing
        dst.unlink(missing_ok=True)
        raise ProcessingFailed("STORAGE_ERROR", str(exc)) from exc

    duration_ms = round(probe.duration_seconds * 1000)
    # Re-check on the *processed* file: this is the duration users will hear.
    if duration_ms < settings.min_audio_seconds * 1000:
        dst.unlink(missing_ok=True)
        raise ProcessingFailed("AUDIO_TOO_SHORT", f"Processed audio is {duration_ms} ms")
    return peaks, duration_ms


async def _wait_for_older_messages(
    settings: Settings, session_factory: async_sessionmaker[AsyncSession], mid: uuid.UUID
) -> None:
    """Hold back publication while an older message in the channel is in flight."""
    deadline = asyncio.get_running_loop().time() + settings.ordering_wait_seconds
    stale_before = datetime.now(UTC) - timedelta(seconds=settings.processing_stale_seconds)
    while True:
        async with session_factory() as session:
            message = await session.get(Message, mid)
            if message is None:
                return
            if not await MessageRepository(session).has_older_in_flight(message, stale_before):
                return
        if asyncio.get_running_loop().time() >= deadline:
            logger.warning("ordering_wait_expired", extra={"message_id": str(mid)})
            return
        await asyncio.sleep(ORDERING_POLL_SECONDS)


async def _mark_ready(
    session_factory: async_sessionmaker[AsyncSession],
    mid: uuid.UUID,
    audio_key: str,
    duration_ms: int,
    waveform: list[float],
) -> int | None:
    async with session_factory() as session, session.begin():
        message = (
            await session.execute(select(Message).where(Message.id == mid).with_for_update())
        ).scalar_one_or_none()
        if message is None or message.status != MessageStatus.PROCESSING.value:
            return None
        # The channel row lock serializes seq assignment across all workers.
        channel = await MessageRepository(session).lock_channel(message.channel_id)
        channel.last_seq += 1
        message.seq = channel.last_seq
        message.status = MessageStatus.READY.value
        message.audio_path = audio_key
        message.duration_ms = duration_ms
        message.waveform = waveform
        message.processed_at = datetime.now(UTC)
        return message.seq


async def _publish_ready(ctx: dict[str, Any], mid: uuid.UUID, channel_id: int) -> None:
    _, session_factory, _ = _deps(ctx)
    async with session_factory() as session:
        row = (
            await session.execute(
                select(Message, User.username, User.avatar_path)
                .join(User, User.id == Message.sender_id)
                .where(Message.id == mid)
            )
        ).one()
        message, username, avatar_path = row
        recipients = max(await ChannelRepository(session).member_count(channel_id) - 1, 0)
        out = to_out(
            message,
            username,
            sender_avatar_path=avatar_path,
            viewer_id=message.sender_id,
            recipients=recipients,
        )
    await events.publish_event(ctx["redis"], channel_id, events.message_new(out))


async def _mark_failed(ctx: dict[str, Any], mid: uuid.UUID, code: str) -> None:
    _, session_factory, storage = _deps(ctx)
    try:
        async with session_factory() as session, session.begin():
            message = (
                await session.execute(select(Message).where(Message.id == mid).with_for_update())
            ).scalar_one_or_none()
            if message is None or message.status != MessageStatus.PROCESSING.value:
                return
            message.status = MessageStatus.FAILED.value
            message.error_code = code
            message.processed_at = datetime.now(UTC)
            channel_id, sender_id, client_id = message.channel_id, message.sender_id, message.client_id
    except TRANSIENT_ERRORS as exc:
        # DB is down: the stale sweeper marks it failed once the DB is back.
        logger.error("mark_failed_db_unavailable", extra={"message_id": str(mid), "error": type(exc).__name__})
        return
    _safe_delete(storage, storage.upload_key(mid))
    _safe_delete(storage, storage.audio_key(mid))
    await events.publish_event(
        ctx["redis"], channel_id, events.message_failed(str(mid), str(client_id), sender_id, code)
    )


def _safe_delete(storage: LocalStorage, key: str) -> None:
    try:
        storage.delete(key)
    except StorageError as exc:
        logger.warning("cleanup_failed", extra={"key": key, "error": str(exc)})


async def sweep_stale_messages(ctx: dict[str, Any]) -> int:
    """Cron: fail messages stuck in `processing` (e.g. worker was down/crashed)."""
    settings, session_factory, storage = _deps(ctx)
    stale_before = datetime.now(UTC) - timedelta(seconds=settings.processing_stale_seconds)
    async with session_factory() as session, session.begin():
        stale = await MessageRepository(session).fail_stale(stale_before)
        failed = [(m.id, m.client_id, m.channel_id, m.sender_id) for m in stale]
    for mid, client_id, channel_id, sender_id in failed:
        _safe_delete(storage, storage.upload_key(mid))
        _safe_delete(storage, storage.audio_key(mid))
        await events.publish_event(
            ctx["redis"], channel_id,
            events.message_failed(str(mid), str(client_id), sender_id, "PROCESSING_TIMEOUT"),
        )
    if failed:
        logger.warning("stale_messages_failed", extra={"count": len(failed)})
    return len(failed)
