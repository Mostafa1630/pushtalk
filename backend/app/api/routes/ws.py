"""Channel WebSocket: authentication, presence, receipts and event fan-out.

Protocol (JSON text frames)
---------------------------
client -> server
    {"type": "hello", "token": "<jwt>"}          first frame, within WS_AUTH_TIMEOUT_SECONDS
    {"type": "ping"}                              heartbeat (keeps presence alive)
    {"type": "ack", "delivered": ["<uuid>", ...]} messages received by this client
    {"type": "played", "message_id": "<uuid>"}    playback finished

server -> client
    ready, message.new, message.failed, message.status, presence, resync, pong, error

The token is sent in the first frame instead of the URL so it never lands in
proxy/access logs. Close codes 4xxx are "don't retry" (auth/permission);
1011/1013/4408 are transient and the client reconnects with backoff.
"""

import asyncio
import contextlib
import json
import logging
import uuid
from typing import Annotated, Any, Literal

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field, TypeAdapter, ValidationError

from app.core.config import get_settings
from app.core.errors import AppError, Forbidden, NotFound
from app.core.security import decode_access_token
from app.db.session import SessionLocal
from app.realtime import events
from app.realtime.hub import ClientConnection, RealtimeHub
from app.realtime.presence import PresenceStore
from app.repositories.messages import MessageRepository
from app.services import message_service
from app.services.channel_service import require_member_channel

router = APIRouter(tags=["realtime"])
logger = logging.getLogger("app.ws")

CLOSE_BAD_REQUEST = 4400
CLOSE_UNAUTHORIZED = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_NOT_FOUND = 4404
CLOSE_SLOW_CONSUMER = 4408
CLOSE_TRY_AGAIN = 1013


class HelloFrame(BaseModel):
    type: Literal["hello"]
    token: str = Field(min_length=1, max_length=4096)


class PingFrame(BaseModel):
    type: Literal["ping"]


class AckFrame(BaseModel):
    type: Literal["ack"]
    delivered: list[uuid.UUID] = Field(max_length=200)


class PlayedFrame(BaseModel):
    type: Literal["played"]
    message_id: uuid.UUID


ClientFrame = TypeAdapter(
    Annotated[PingFrame | AckFrame | PlayedFrame, Field(discriminator="type")]
)


async def _authenticate(websocket: WebSocket, channel_id: int) -> int | None:
    """Wait for the hello frame; returns user id or closes the socket."""
    settings = get_settings()
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=settings.ws_auth_timeout_seconds)
        hello = HelloFrame.model_validate_json(raw)
    except TimeoutError:
        await websocket.close(CLOSE_UNAUTHORIZED, "Authentication timeout")
        return None
    except (ValidationError, ValueError):
        await websocket.close(CLOSE_BAD_REQUEST, "Expected hello frame")
        return None

    try:
        user_id = decode_access_token(hello.token)
        async with SessionLocal() as session:
            await require_member_channel(session, user_id, channel_id)
    except NotFound:
        await websocket.close(CLOSE_NOT_FOUND, "Channel not found")
        return None
    except Forbidden:
        await websocket.close(CLOSE_FORBIDDEN, "Not a channel member")
        return None
    except AppError as exc:  # Unauthorized (invalid / expired token)
        await websocket.close(CLOSE_UNAUTHORIZED, exc.code)
        return None
    return user_id


async def _writer(websocket: WebSocket, conn: ClientConnection) -> None:
    while True:
        event = await conn.outbox.get()
        if event is None:
            return
        await websocket.send_text(json.dumps(event, default=str))


async def _reader(
    websocket: WebSocket, conn: ClientConnection, presence: PresenceStore, hub: RealtimeHub
) -> None:
    settings = get_settings()
    idle_timeout = settings.presence_ttl_seconds  # no frame (not even ping) for this long => dead
    while True:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=idle_timeout)
        try:
            frame = ClientFrame.validate_json(raw)
        except ValidationError:
            conn.offer({"type": events.EVT_ERROR, "code": "BAD_FRAME", "message": "Unrecognized frame"})
            continue

        if isinstance(frame, PingFrame):
            await presence.touch(conn.channel_id, conn.user_id, conn.connection_id)
            conn.offer({"type": events.EVT_PONG})
        elif isinstance(frame, AckFrame):
            async with SessionLocal() as session:
                await message_service.record_delivered(
                    session, hub.redis, conn.user_id, conn.channel_id, frame.delivered
                )
        elif isinstance(frame, PlayedFrame):
            async with SessionLocal() as session:
                await message_service.record_played(
                    session, hub.redis, conn.user_id, conn.channel_id, frame.message_id
                )


async def _publish_presence(presence: PresenceStore, hub: RealtimeHub, channel_id: int) -> list[int]:
    online = await presence.online_user_ids(channel_id)
    await events.publish_event(hub.redis, channel_id, events.presence(online))
    return online


@router.websocket("/ws/channels/{channel_id}")
async def channel_socket(websocket: WebSocket, channel_id: int) -> None:
    await websocket.accept()
    user_id = await _authenticate(websocket, channel_id)
    if user_id is None:
        return

    hub: RealtimeHub = websocket.app.state.hub
    if not hub.healthy:
        # Without a live subscription we would silently drop events.
        await websocket.close(CLOSE_TRY_AGAIN, "Realtime temporarily unavailable")
        return

    settings = get_settings()
    presence = PresenceStore(hub.redis, settings.presence_ttl_seconds)
    conn = ClientConnection(uuid.uuid4().hex[:12], channel_id, user_id)
    log_ctx: dict[str, Any] = {"channel_id": channel_id, "user_id": user_id, "conn": conn.connection_id}

    # Register BEFORE reading latest_seq: every event published after this
    # point reaches the socket, and everything before it is in the database,
    # so the client's HTTP catch-up (after `ready`) cannot miss a message.
    hub.register(conn)
    tasks: list[asyncio.Task[None]] = []
    try:
        await presence.touch(channel_id, user_id, conn.connection_id)
        async with SessionLocal() as session:
            latest_seq = await MessageRepository(session).latest_seq(channel_id)
        # `ready` is sent directly, before the writer starts draining the outbox,
        # so it is always the first frame even if events were queued meanwhile.
        ready = {
            "type": events.EVT_READY,
            "user_id": user_id,
            "latest_seq": latest_seq,
            "online": await presence.online_user_ids(channel_id),
        }
        await websocket.send_text(json.dumps(ready))
        await _publish_presence(presence, hub, channel_id)
        logger.info("ws_connected", extra=log_ctx)

        tasks = [
            asyncio.create_task(_writer(websocket, conn)),
            asyncio.create_task(_reader(websocket, conn, presence, hub)),
        ]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            exc = task.exception()
            if exc and not isinstance(exc, WebSocketDisconnect):
                raise exc
        if conn.overflowed:
            await websocket.close(CLOSE_SLOW_CONSUMER, "Client too slow, reconnect")
    except WebSocketDisconnect:
        pass
    except TimeoutError:
        logger.info("ws_idle_timeout", extra=log_ctx)
        with contextlib.suppress(Exception):
            await websocket.close(CLOSE_TRY_AGAIN, "Idle timeout")
    except Exception as exc:  # noqa: BLE001 - Redis/DB failure mid-connection
        logger.error("ws_error", extra={**log_ctx, "error": type(exc).__name__})
        with contextlib.suppress(Exception):
            await websocket.close(1011, "Server error, reconnect")
    finally:
        for task in tasks:
            task.cancel()
        hub.unregister(conn)
        with contextlib.suppress(Exception):
            await presence.remove(channel_id, user_id, conn.connection_id)
            await _publish_presence(presence, hub, channel_id)
        logger.info("ws_disconnected", extra=log_ctx)
