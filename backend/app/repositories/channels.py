from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import exists, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.models import Channel, ChannelMember, User


@dataclass(frozen=True)
class ChannelRow:
    channel: Channel
    member_count: int
    is_member: bool


@dataclass(frozen=True)
class DmRow:
    channel: Channel
    other_user_id: int
    other_username: str
    other_avatar_path: str | None


@dataclass(frozen=True)
class MemberRow:
    user_id: int
    username: str
    joined_at: datetime
    avatar_path: str | None


class ChannelRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get(self, channel_id: int) -> Channel | None:
        return await self.session.get(Channel, channel_id)

    async def get_by_name(self, name: str) -> Channel | None:
        result = await self.session.execute(select(Channel).where(Channel.name == name))
        return result.scalar_one_or_none()

    async def add(self, name: str, created_by: int, description: str = "") -> Channel:
        channel = Channel(name=name, created_by=created_by, description=description)
        self.session.add(channel)
        await self.session.flush()
        return channel

    @staticmethod
    def dm_channel_name(user_a_id: int, user_b_id: int) -> str:
        low, high = sorted([user_a_id, user_b_id])
        return f"dm:{low}:{high}"

    async def get_dm_channel(self, user_a_id: int, user_b_id: int) -> Channel | None:
        name = self.dm_channel_name(user_a_id, user_b_id)
        return await self.get_by_name(name)

    async def create_dm_channel(self, user_a_id: int, user_b_id: int) -> Channel:
        name = self.dm_channel_name(user_a_id, user_b_id)
        channel = Channel(name=name, created_by=user_a_id, is_direct=True, description="")
        self.session.add(channel)
        await self.session.flush()
        await self.add_member(channel.id, user_a_id)
        await self.add_member(channel.id, user_b_id)
        return channel

    async def list_with_counts(self, user_id: int) -> list[ChannelRow]:
        member_count = (
            select(func.count())
            .where(ChannelMember.channel_id == Channel.id)
            .correlate(Channel)
            .scalar_subquery()
        )
        is_member = exists().where(
            ChannelMember.channel_id == Channel.id, ChannelMember.user_id == user_id
        )
        result = await self.session.execute(
            select(Channel, member_count, is_member)
            .where(Channel.is_direct.is_(False))
            .order_by(Channel.name)
        )
        return [ChannelRow(c, int(n), bool(m)) for c, n, m in result.all()]

    async def list_dms(self, user_id: int) -> list[DmRow]:
        cm1 = aliased(ChannelMember)
        cm2 = aliased(ChannelMember)
        stmt = (
            select(Channel, User.id, User.username, User.avatar_path)
            .join(cm1, cm1.channel_id == Channel.id)
            .join(cm2, (cm2.channel_id == Channel.id) & (cm2.user_id != user_id))
            .join(User, User.id == cm2.user_id)
            .where(Channel.is_direct.is_(True), cm1.user_id == user_id)
            .order_by(User.username)
        )
        result = await self.session.execute(stmt)
        return [DmRow(c, uid, uname, apath) for c, uid, uname, apath in result.all()]

    async def get_dm_other_member(self, channel_id: int, viewer_id: int) -> tuple[int, str, str | None] | None:
        stmt = (
            select(User.id, User.username, User.avatar_path)
            .join(ChannelMember, ChannelMember.user_id == User.id)
            .where(ChannelMember.channel_id == channel_id, User.id != viewer_id)
            .limit(1)
        )
        result = await self.session.execute(stmt)
        row = result.first()
        return (row[0], row[1], row[2]) if row else None

    async def is_member(self, channel_id: int, user_id: int) -> bool:
        result = await self.session.execute(
            select(
                exists().where(
                    ChannelMember.channel_id == channel_id, ChannelMember.user_id == user_id
                )
            )
        )
        return bool(result.scalar())

    async def add_member(self, channel_id: int, user_id: int) -> bool:
        """Insert membership; returns False if it already existed (idempotent join)."""
        stmt = (
            insert(ChannelMember)
            .values(channel_id=channel_id, user_id=user_id)
            .on_conflict_do_nothing(index_elements=["channel_id", "user_id"])
            .returning(ChannelMember.user_id)
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def member_count(self, channel_id: int) -> int:
        result = await self.session.execute(
            select(func.count()).where(ChannelMember.channel_id == channel_id)
        )
        return int(result.scalar_one())

    async def list_members(self, channel_id: int) -> list[MemberRow]:
        result = await self.session.execute(
            select(User.id, User.username, ChannelMember.joined_at, User.avatar_path)
            .join(ChannelMember, ChannelMember.user_id == User.id)
            .where(ChannelMember.channel_id == channel_id)
            .order_by(User.username)
        )
        return [MemberRow(uid, name, joined, avatar) for uid, name, joined, avatar in result.all()]
