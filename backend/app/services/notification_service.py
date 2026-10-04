"""Creating, listing and reading user notifications.

Creation is best-effort: a notification failure (DB down, Redis down) must
never fail the action that triggered it — the DB row is the source of truth
and the realtime push is fire-and-forget.
"""

import logging

from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Notification
from app.realtime import events
from app.repositories.notifications import NotificationRepository, NotificationRow
from app.schemas.notification import MarkedRead, NotificationOut, NotificationPage, UnreadCount

logger = logging.getLogger("app.notifications")

TYPE_CHANNEL_JOINED = "channel_joined"
TYPE_CHANNEL_MESSAGE = "channel_message"


def to_out(row: NotificationRow) -> NotificationOut:
    n = row.notification
    return NotificationOut(
        id=n.id,
        type=n.type,
        title=n.title,
        body=n.body,
        related_id=n.related_id,
        channel_name=row.channel_name,
        actor_username=row.actor_username,
        is_read=n.is_read,
        created_at=n.created_at,
    )


async def notify_channel_joined(
    session: AsyncSession,
    redis: Redis,
    *,
    user_id: int,
    username: str,
    channel_id: int,
    channel_name: str,
) -> None:
    """"Congratulations, you joined #x" — sent to the user who just joined."""
    notification = Notification(
        user_id=user_id,
        type=TYPE_CHANNEL_JOINED,
        title="Channel joined",
        body=f"Congratulations! You successfully joined #{channel_name}.",
        related_id=channel_id,
        actor_id=user_id,
    )
    await _create_and_push(
        session, redis, notification, channel_name=channel_name, actor_username=username
    )


async def notify_channel_message(
    session: AsyncSession,
    redis: Redis,
    *,
    owner_id: int,
    channel_id: int,
    channel_name: str,
    sender_id: int,
    sender_username: str,
) -> None:
    """New voice message in a channel the user created. Never notifies the sender."""
    if owner_id == sender_id:
        return
    notification = Notification(
        user_id=owner_id,
        type=TYPE_CHANNEL_MESSAGE,
        title="New voice message",
        body=f"New voice message in #{channel_name} from {sender_username}.",
        related_id=channel_id,
        actor_id=sender_id,
    )
    await _create_and_push(
        session, redis, notification, channel_name=channel_name, actor_username=sender_username
    )


async def _create_and_push(
    session: AsyncSession,
    redis: Redis,
    notification: Notification,
    *,
    channel_name: str | None,
    actor_username: str | None,
) -> None:
    try:
        NotificationRepository(session).add(notification)
        await session.commit()
    except Exception as exc:  # noqa: BLE001 - notifications must never break the trigger
        await session.rollback()
        logger.error(
            "notification_create_failed",
            extra={"type": notification.type, "error": type(exc).__name__},
        )
        return
    await events.publish_user_event(
        redis,
        notification.user_id,
        events.notification_new(
            NotificationOut(
                id=notification.id,
                type=notification.type,
                title=notification.title,
                body=notification.body,
                related_id=notification.related_id,
                channel_name=channel_name,
                actor_username=actor_username,
                is_read=notification.is_read,
                created_at=notification.created_at,
            )
        ),
    )


# ---- queries -------------------------------------------------------------------
async def list_notifications(
    session: AsyncSession, user_id: int, *, before_id: int | None, limit: int
) -> NotificationPage:
    rows, has_more = await NotificationRepository(session).list_for_user(
        user_id, before_id=before_id, limit=limit
    )
    return NotificationPage(notifications=[to_out(r) for r in rows], has_more=has_more)


async def unread_count(session: AsyncSession, user_id: int) -> UnreadCount:
    return UnreadCount(count=await NotificationRepository(session).unread_count(user_id))


async def mark_read(session: AsyncSession, user_id: int, notification_id: int) -> NotificationOut | None:
    row = await NotificationRepository(session).mark_read(user_id, notification_id)
    if row is None:
        return None
    await session.commit()
    return to_out(row)


async def mark_all_read(session: AsyncSession, user_id: int) -> MarkedRead:
    count = await NotificationRepository(session).mark_all_read(user_id)
    await session.commit()
    return MarkedRead(count=count)
