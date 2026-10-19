"""Voice messages: upload, history/catch-up, receipts and protected media."""

import logging
import uuid
from pathlib import Path

from redis.asyncio import Redis
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import NotFound, ServiceUnavailable
from app.images import avatar_url_for
from app.models import Message, MessageStatus, User
from app.realtime import events
from app.repositories.channels import ChannelRepository
from app.repositories.messages import MessageRepository, MessageRow, ReceiptCounts
from app.schemas.message import MessageOut, MessagePage, ReceiptSummary
from app.services import audio_validation
from app.services.channel_service import require_member_channel
from app.services.job_queue import JobQueue
from app.storage.local import LocalStorage, StorageError

logger = logging.getLogger("app.messages")

QUEUE_UNAVAILABLE = "QUEUE_UNAVAILABLE"


# --------------------------------------------------------------------------
# Serialization
# --------------------------------------------------------------------------
def to_out(
    message: Message,
    sender_username: str,
    *,
    sender_avatar_path: str | None = None,
    viewer_id: int,
    played_by_me: bool = False,
    counts: ReceiptCounts | None = None,
    recipients: int = 0,
) -> MessageOut:
    receipts = None
    if message.sender_id == viewer_id and message.status == MessageStatus.READY.value:
        c = counts or ReceiptCounts(0, 0)
        receipts = ReceiptSummary(recipients=recipients, delivered=c.delivered, played=c.played)
    return MessageOut(
        id=message.id,
        client_id=message.client_id,
        channel_id=message.channel_id,
        sender_id=message.sender_id,
        sender_username=sender_username,
        sender_avatar_url=avatar_url_for(message.sender_id, sender_avatar_path),
        status=message.status,
        seq=message.seq,
        duration_ms=message.duration_ms,
        waveform=message.waveform,
        transcript=message.transcript,
        error_code=message.error_code,
        created_at=message.created_at,
        receipts=receipts,
        played_by_me=played_by_me,
    )


# --------------------------------------------------------------------------
# Upload
# --------------------------------------------------------------------------
async def upload_message(
    *,
    session: AsyncSession,
    storage: LocalStorage,
    queue: JobQueue,
    settings: Settings,
    user: User,
    channel_id: int,
    client_id: uuid.UUID,
    data: bytes,
    declared_content_type: str | None,
) -> tuple[MessageOut, bool]:
    """Validate, persist and enqueue a recording. Returns (message, created)."""
    await require_member_channel(session, user.id, channel_id)
    repo = MessageRepository(session)

    # Idempotency: the client retries a failed/interrupted upload with the same
    # client_id; we return the original message instead of creating a duplicate.
    existing = await repo.get_by_client_id(user.id, client_id)
    if existing is not None:
        if existing.channel_id != channel_id:
            raise NotFound("Message not found", code="MESSAGE_NOT_FOUND")
        if (
            existing.status == MessageStatus.FAILED.value
            and existing.error_code == QUEUE_UNAVAILABLE
            and storage.exists(existing.upload_path)
        ):
            # The only retryable server-side failure: the upload is valid and
            # still stored, it just never reached the queue. Try again.
            existing.status = MessageStatus.PROCESSING.value
            existing.error_code = None
            await session.commit()
            await _enqueue_or_fail(session, queue, existing)
            logger.info("message_requeued", extra={"message_id": str(existing.id)})
            return to_out(existing, user.username, sender_avatar_path=user.avatar_path, viewer_id=user.id), True
        return to_out(existing, user.username, sender_avatar_path=user.avatar_path, viewer_id=user.id), False

    detected_mime = audio_validation.check_bytes(data, declared_content_type, settings)

    message_id = uuid.uuid4()
    upload_key = storage.upload_key(message_id)
    try:
        storage.write_bytes(upload_key, data)
    except StorageError as exc:
        logger.error("upload_store_failed", extra={"channel_id": channel_id, "error": str(exc)})
        raise ServiceUnavailable("Could not store the recording", code="STORAGE_UNAVAILABLE") from exc

    try:
        duration = await audio_validation.check_duration(storage.path_for(upload_key), settings)
    except Exception:
        storage.delete(upload_key)
        raise

    message = Message(
        id=message_id,
        channel_id=channel_id,
        sender_id=user.id,
        client_id=client_id,
        status=MessageStatus.PROCESSING.value,
        upload_path=upload_key,
        upload_mime=detected_mime,
        upload_bytes=len(data),
    )
    repo.add(message)
    try:
        await session.commit()
    except IntegrityError:
        # Concurrent retry with the same client_id won the race.
        await session.rollback()
        storage.delete(upload_key)
        existing = await repo.get_by_client_id(user.id, client_id)
        if existing is None:
            raise
        return to_out(existing, user.username, sender_avatar_path=user.avatar_path, viewer_id=user.id), False

    logger.info(
        "message_uploaded",
        extra={
            "message_id": str(message_id),
            "channel_id": channel_id,
            "user_id": user.id,
            "mime": detected_mime,
            "bytes": len(data),
            "duration_s": round(duration, 3),
        },
    )

    await _enqueue_or_fail(session, queue, message)
    return to_out(message, user.username, sender_avatar_path=user.avatar_path, viewer_id=user.id), True


async def _enqueue_or_fail(session: AsyncSession, queue: JobQueue, message: Message) -> None:
    """Enqueue processing. If the queue (Redis) is down, record the failure and
    answer 503. The raw upload is kept so a retry with the same client_id can
    re-enqueue it without the client re-sending anything invalid."""
    try:
        await queue.enqueue_processing(message.id)
    except Exception as exc:  # noqa: BLE001 - Redis/queue down
        logger.error("enqueue_failed", extra={"message_id": str(message.id), "error": type(exc).__name__})
        message.status = MessageStatus.FAILED.value
        message.error_code = QUEUE_UNAVAILABLE
        await session.commit()
        raise ServiceUnavailable(
            "Processing queue is unavailable, please try again",
            code=QUEUE_UNAVAILABLE,
            details={"message_id": str(message.id)},
        ) from exc


# --------------------------------------------------------------------------
# History & catch-up
# --------------------------------------------------------------------------
async def list_messages(
    session: AsyncSession,
    user: User,
    channel_id: int,
    *,
    after_seq: int | None,
    before_seq: int | None,
    limit: int,
) -> MessagePage:
    await require_member_channel(session, user.id, channel_id)
    repo = MessageRepository(session)
    latest_seq = await repo.latest_seq(channel_id)
    rows, has_more = await repo.list_ready(
        channel_id, user.id, after_seq=after_seq, before_seq=before_seq, limit=limit
    )
    # The sender also needs their in-flight and failed messages (they are never
    # broadcast, so without this a reload would silently hide a failure).
    if before_seq is None:
        rows = rows + await repo.list_own_unready(channel_id, user.id)
    return MessagePage(
        messages=await _serialize_rows(session, rows, user.id, channel_id),
        latest_seq=latest_seq,
        has_more=has_more,
    )


async def _serialize_rows(
    session: AsyncSession, rows: list[MessageRow], viewer_id: int, channel_id: int
) -> list[MessageOut]:
    own_ids = [r.message.id for r in rows if r.message.sender_id == viewer_id]
    counts = await MessageRepository(session).receipt_counts(own_ids)
    recipients = max(await ChannelRepository(session).member_count(channel_id) - 1, 0) if own_ids else 0
    return [
        to_out(
            r.message,
            r.sender_username,
            sender_avatar_path=r.sender_avatar_path,
            viewer_id=viewer_id,
            played_by_me=r.played_by_me,
            counts=counts.get(r.message.id),
            recipients=recipients,
        )
        for r in rows
    ]


# --------------------------------------------------------------------------
# Receipts (called from the WebSocket handler)
# --------------------------------------------------------------------------
async def record_delivered(
    session: AsyncSession, redis: Redis, user_id: int, channel_id: int, message_ids: list[uuid.UUID]
) -> None:
    repo = MessageRepository(session)
    newly = await repo.mark_delivered(channel_id, user_id, message_ids)
    await session.commit()
    await _publish_receipts(session, redis, channel_id, user_id, newly, kind="delivered")


async def record_played(
    session: AsyncSession, redis: Redis, user_id: int, channel_id: int, message_id: uuid.UUID
) -> None:
    repo = MessageRepository(session)
    changed = await repo.mark_played(channel_id, user_id, message_id)
    await session.commit()
    if changed:
        await _publish_receipts(session, redis, channel_id, user_id, [message_id], kind="played")


async def _publish_receipts(
    session: AsyncSession,
    redis: Redis,
    channel_id: int,
    user_id: int,
    message_ids: list[uuid.UUID],
    *,
    kind: str,
) -> None:
    if not message_ids:
        return
    counts = await MessageRepository(session).receipt_counts(message_ids)
    recipients = max(await ChannelRepository(session).member_count(channel_id) - 1, 0)
    for mid in message_ids:
        c = counts.get(mid, ReceiptCounts(0, 0))
        await events.publish_event(
            redis,
            channel_id,
            events.message_status(
                str(mid), user_id=user_id, kind=kind, recipients=recipients,
                delivered=c.delivered, played=c.played,
            ),
        )


# --------------------------------------------------------------------------
# Protected media
# --------------------------------------------------------------------------
async def resolve_audio_file(
    session: AsyncSession, storage: LocalStorage, user: User, message_id: uuid.UUID
) -> Path:
    """Return the processed audio path if (and only if) the user may hear it."""
    message = await MessageRepository(session).get(message_id)
    if message is None:
        raise NotFound("Audio not found", code="AUDIO_NOT_FOUND")
    # Membership check BEFORE revealing anything about the message's state.
    await require_member_channel(session, user.id, message.channel_id)
    if message.status != MessageStatus.READY.value or not message.audio_path:
        raise NotFound("Audio is not available", code="AUDIO_NOT_READY")
    path = storage.path_for(message.audio_path)
    if not path.is_file():
        logger.error("audio_file_missing", extra={"message_id": str(message_id)})
        raise NotFound("Audio file is missing", code="AUDIO_FILE_MISSING")
    return path
