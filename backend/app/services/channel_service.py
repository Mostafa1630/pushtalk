"""Channels, membership, owner edits and member presence."""

import logging

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, Forbidden, NotFound, PayloadTooLarge, ServiceUnavailable, UnsupportedMedia
from app.images import MAX_IMAGE_BYTES, extension_for, sniff_image
from app.models import Channel, User
from app.realtime.presence import PresenceStore
from app.repositories.channels import ChannelRepository, ChannelRow, MemberRow
from app.schemas.channel import ChannelCreate, ChannelOut, ChannelUpdate, MemberOut
from app.storage.local import LocalStorage, StorageError

logger = logging.getLogger("app.channels")


def _image_url(channel: Channel) -> str | None:
    return f"/api/channels/{channel.id}/image" if channel.image_path else None


def _avatar_url(user_id: int, avatar_path: str | None) -> str | None:
    return f"/api/users/{user_id}/avatar" if avatar_path else None


def to_out(channel: Channel, *, member_count: int, is_member: bool, viewer_id: int) -> ChannelOut:
    return ChannelOut(
        id=channel.id,
        name=channel.name,
        description=channel.description or "",
        created_at=channel.created_at,
        created_by=channel.created_by,
        member_count=member_count,
        is_member=is_member,
        is_owner=channel.created_by == viewer_id,
        image_url=_image_url(channel),
    )


def _from_row(row: ChannelRow, viewer_id: int) -> ChannelOut:
    return to_out(row.channel, member_count=row.member_count, is_member=row.is_member, viewer_id=viewer_id)


async def list_channels(session: AsyncSession, user: User) -> list[ChannelOut]:
    rows = await ChannelRepository(session).list_with_counts(user.id)
    return [_from_row(r, user.id) for r in rows]


async def get_channel(session: AsyncSession, user: User, channel_id: int) -> ChannelOut:
    repo = ChannelRepository(session)
    channel = await repo.get(channel_id)
    if channel is None:
        raise NotFound("Channel not found", code="CHANNEL_NOT_FOUND")
    return to_out(
        channel,
        member_count=await repo.member_count(channel_id),
        is_member=await repo.is_member(channel_id, user.id),
        viewer_id=user.id,
    )


async def create_channel(session: AsyncSession, user: User, data: ChannelCreate) -> ChannelOut:
    repo = ChannelRepository(session)
    if await repo.get_by_name(data.name) is not None:
        raise Conflict("A channel with this name already exists", code="CHANNEL_EXISTS")
    try:
        channel = await repo.add(data.name, created_by=user.id, description=data.description)
        await repo.add_member(channel.id, user.id)
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise Conflict("A channel with this name already exists", code="CHANNEL_EXISTS") from exc
    logger.info("channel_created", extra={"channel_id": channel.id, "user_id": user.id})
    return to_out(channel, member_count=1, is_member=True, viewer_id=user.id)


async def join_channel(session: AsyncSession, user: User, channel_id: int) -> ChannelOut:
    repo = ChannelRepository(session)
    channel = await repo.get(channel_id)
    if channel is None:
        raise NotFound("Channel not found", code="CHANNEL_NOT_FOUND")
    created = await repo.add_member(channel_id, user.id)
    await session.commit()
    if created:
        logger.info("channel_joined", extra={"channel_id": channel_id, "user_id": user.id})
    return to_out(
        channel,
        member_count=await repo.member_count(channel_id),
        is_member=True,
        viewer_id=user.id,
    )


async def require_member_channel(session: AsyncSession, user_id: int, channel_id: int) -> Channel:
    repo = ChannelRepository(session)
    channel = await repo.get(channel_id)
    if channel is None:
        raise NotFound("Channel not found", code="CHANNEL_NOT_FOUND")
    if not await repo.is_member(channel_id, user_id):
        raise Forbidden("Join this channel first", code="NOT_A_MEMBER")
    return channel


async def require_owner_channel(session: AsyncSession, user: User, channel_id: int) -> Channel:
    channel = await require_member_channel(session, user.id, channel_id)
    if channel.created_by != user.id:
        raise Forbidden("Only the channel creator can do this", code="NOT_CHANNEL_OWNER")
    return channel


async def update_channel(
    session: AsyncSession, user: User, channel_id: int, data: ChannelUpdate
) -> ChannelOut:
    channel = await require_owner_channel(session, user, channel_id)
    repo = ChannelRepository(session)
    if data.name is not None and data.name != channel.name:
        existing = await repo.get_by_name(data.name)
        if existing is not None and existing.id != channel.id:
            raise Conflict("A channel with this name already exists", code="CHANNEL_EXISTS")
        channel.name = data.name
    if data.description is not None:
        channel.description = data.description
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise Conflict("A channel with this name already exists", code="CHANNEL_EXISTS") from exc
    logger.info("channel_updated", extra={"channel_id": channel.id, "user_id": user.id})
    return to_out(
        channel,
        member_count=await repo.member_count(channel_id),
        is_member=True,
        viewer_id=user.id,
    )


async def delete_channel(session: AsyncSession, storage: LocalStorage, user: User, channel_id: int) -> None:
    channel = await require_owner_channel(session, user, channel_id)
    if channel.image_path:
        storage.delete(channel.image_path)
    await session.delete(channel)
    await session.commit()
    logger.info("channel_deleted", extra={"channel_id": channel_id, "user_id": user.id})


async def set_channel_image(
    session: AsyncSession, storage: LocalStorage, user: User, channel_id: int, data: bytes
) -> ChannelOut:
    channel = await require_owner_channel(session, user, channel_id)
    if not data:
        raise UnsupportedMedia("Image is empty", code="EMPTY_FILE")
    if len(data) > MAX_IMAGE_BYTES:
        raise PayloadTooLarge("Channel photo must be 2 MB or smaller")
    mime = sniff_image(data[:16])
    if mime is None:
        raise UnsupportedMedia("Use a JPEG, PNG or WebP photo", code="UNRECOGNIZED_IMAGE")
    key = storage.channel_image_key(channel.id, extension_for(mime))
    try:
        storage.write_bytes(key, data)
    except StorageError as exc:
        raise ServiceUnavailable("Could not store the photo", code="STORAGE_UNAVAILABLE") from exc
    if channel.image_path and channel.image_path != key:
        storage.delete(channel.image_path)
    channel.image_path = key
    await session.commit()
    repo = ChannelRepository(session)
    return to_out(
        channel,
        member_count=await repo.member_count(channel_id),
        is_member=True,
        viewer_id=user.id,
    )


async def list_members(
    session: AsyncSession, presence: PresenceStore, user: User, channel_id: int
) -> list[MemberOut]:
    await require_member_channel(session, user.id, channel_id)
    members = await ChannelRepository(session).list_members(channel_id)
    try:
        online = set(await presence.online_user_ids(channel_id))
    except Exception:  # noqa: BLE001 - Redis down: still list members, all offline
        logger.warning("presence_unavailable", extra={"channel_id": channel_id})
        online = set()
    return [_member_out(m, m.user_id in online) for m in members]


def _member_out(m: MemberRow, online: bool) -> MemberOut:
    return MemberOut(
        user_id=m.user_id,
        username=m.username,
        joined_at=m.joined_at,
        online=online,
        avatar_url=_avatar_url(m.user_id, m.avatar_path),
    )
