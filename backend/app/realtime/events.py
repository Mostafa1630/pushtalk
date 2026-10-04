"""Realtime event names, payload builders and the Redis publish helper.

Both the API process and the worker publish through `publish_event`, and every
API process fans events out to its local WebSocket connections (see hub.py).
Redis pub/sub is fire-and-forget: it is only the *notification* path. The
database is the source of truth, and clients recover anything they missed
through the HTTP catch-up endpoint (`GET /messages?after_seq=`).
"""

import json
import logging
from typing import Any

from redis.asyncio import Redis

from app.schemas.message import MessageOut
from app.schemas.notification import NotificationOut

logger = logging.getLogger("app.realtime")

CHANNEL_TOPIC_PREFIX = "pushtalk:channel:"
USER_TOPIC_PREFIX = "pushtalk:user:"

# Server -> client event types
EVT_READY = "ready"
EVT_MESSAGE_NEW = "message.new"
EVT_MESSAGE_FAILED = "message.failed"
EVT_MESSAGE_STATUS = "message.status"
EVT_PRESENCE = "presence"
EVT_RESYNC = "resync"
EVT_NOTIFICATION_NEW = "notification.new"
EVT_ERROR = "error"
EVT_PONG = "pong"


def channel_topic(channel_id: int) -> str:
    return f"{CHANNEL_TOPIC_PREFIX}{channel_id}"


def user_topic(user_id: int) -> str:
    return f"{USER_TOPIC_PREFIX}{user_id}"


def message_new(message: MessageOut) -> dict[str, Any]:
    return {"type": EVT_MESSAGE_NEW, "message": message.model_dump(mode="json")}


def message_failed(message_id: str, client_id: str, sender_id: int, error_code: str) -> dict[str, Any]:
    return {
        "type": EVT_MESSAGE_FAILED,
        "message_id": message_id,
        "client_id": client_id,
        "sender_id": sender_id,
        "error_code": error_code,
    }


def message_status(
    message_id: str, *, user_id: int, kind: str, recipients: int, delivered: int, played: int
) -> dict[str, Any]:
    return {
        "type": EVT_MESSAGE_STATUS,
        "message_id": message_id,
        "user_id": user_id,  # who delivered/played it
        "kind": kind,  # "delivered" | "played"
        "receipts": {"recipients": recipients, "delivered": delivered, "played": played},
    }


def presence(online_user_ids: list[int]) -> dict[str, Any]:
    return {"type": EVT_PRESENCE, "online": sorted(online_user_ids)}


def notification_new(notification: NotificationOut) -> dict[str, Any]:
    return {"type": EVT_NOTIFICATION_NEW, "notification": notification.model_dump(mode="json")}


async def publish_event(redis: Redis, channel_id: int, event: dict[str, Any]) -> bool:
    """Publish to the channel topic. Never raises: realtime is best effort,
    clients catch up from the database. Returns False on failure."""
    return await _publish(redis, channel_topic(channel_id), channel_id=channel_id, event=event)


async def publish_user_event(redis: Redis, user_id: int, event: dict[str, Any]) -> bool:
    """Publish to a user's topic: reaches every connection that user has open
    (any channel socket). Same best-effort contract as publish_event."""
    return await _publish(redis, user_topic(user_id), user_id=user_id, event=event)


async def _publish(redis: Redis, topic: str, *, event: dict[str, Any], **log_ctx: Any) -> bool:
    try:
        await redis.publish(topic, json.dumps(event, default=str))
        return True
    except Exception as exc:  # noqa: BLE001 - Redis down must not break the caller
        logger.error(
            "publish_failed",
            extra={"event": event.get("type"), "error": type(exc).__name__, **log_ctx},
        )
        return False
