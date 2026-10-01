import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import BigInteger, and_, func, literal, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Channel, Message, MessageReceipt, MessageStatus, User

# A sender sees their own processing/failed messages from this far back.
OWN_PENDING_WINDOW = timedelta(hours=24)


@dataclass(frozen=True)
class MessageRow:
    message: Message
    sender_username: str
    sender_avatar_path: str | None
    played_by_me: bool


@dataclass(frozen=True)
class ReceiptCounts:
    delivered: int
    played: int


class MessageRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    # --- basic access -----------------------------------------------------
    async def get(self, message_id: uuid.UUID) -> Message | None:
        return await self.session.get(Message, message_id)

    async def get_by_client_id(self, sender_id: int, client_id: uuid.UUID) -> Message | None:
        result = await self.session.execute(
            select(Message).where(Message.sender_id == sender_id, Message.client_id == client_id)
        )
        return result.scalar_one_or_none()

    def add(self, message: Message) -> None:
        self.session.add(message)

    # --- history / catch-up -----------------------------------------------
    def _rows_query(self, viewer_id: int):  # type: ignore[no-untyped-def]
        my_receipt = (
            select(MessageReceipt.played_at)
            .where(MessageReceipt.message_id == Message.id, MessageReceipt.user_id == viewer_id)
            .correlate(Message)
            .scalar_subquery()
        )
        return select(Message, User.username, User.avatar_path, my_receipt.is_not(None)).join(
            User, User.id == Message.sender_id
        )

    async def list_ready(
        self,
        channel_id: int,
        viewer_id: int,
        *,
        after_seq: int | None,
        before_seq: int | None,
        limit: int,
    ) -> tuple[list[MessageRow], bool]:
        """Ready messages in ascending seq order, plus whether more exist."""
        query = self._rows_query(viewer_id).where(
            Message.channel_id == channel_id, Message.status == MessageStatus.READY.value
        )
        if after_seq is not None:
            # Catch-up: oldest first, starting right after what the client has.
            query = query.where(Message.seq > after_seq).order_by(Message.seq.asc())
        else:
            # Latest page (optionally older than before_seq), newest first then reversed.
            if before_seq is not None:
                query = query.where(Message.seq < before_seq)
            query = query.order_by(Message.seq.desc())
        result = await self.session.execute(query.limit(limit + 1))
        rows = [MessageRow(m, name, avatar, bool(played)) for m, name, avatar, played in result.all()]
        has_more = len(rows) > limit
        rows = rows[:limit]
        if after_seq is None:
            rows.reverse()
        return rows, has_more

    async def list_own_unready(self, channel_id: int, sender_id: int) -> list[MessageRow]:
        since = datetime.now().astimezone() - OWN_PENDING_WINDOW
        query = (
            self._rows_query(sender_id)
            .where(
                Message.channel_id == channel_id,
                Message.sender_id == sender_id,
                Message.status != MessageStatus.READY.value,
                Message.created_at >= since,
            )
            .order_by(Message.created_at.asc())
        )
        result = await self.session.execute(query)
        return [MessageRow(m, name, avatar, bool(played)) for m, name, avatar, played in result.all()]

    async def latest_seq(self, channel_id: int) -> int:
        result = await self.session.execute(select(Channel.last_seq).where(Channel.id == channel_id))
        return int(result.scalar_one_or_none() or 0)

    # --- receipts -----------------------------------------------------------
    async def receipt_counts(self, message_ids: list[uuid.UUID]) -> dict[uuid.UUID, ReceiptCounts]:
        if not message_ids:
            return {}
        result = await self.session.execute(
            select(
                MessageReceipt.message_id,
                func.count(),
                func.count(MessageReceipt.played_at),
            )
            .where(MessageReceipt.message_id.in_(message_ids))
            .group_by(MessageReceipt.message_id)
        )
        return {mid: ReceiptCounts(int(d), int(p)) for mid, d, p in result.all()}

    async def mark_delivered(
        self, channel_id: int, user_id: int, message_ids: list[uuid.UUID]
    ) -> list[uuid.UUID]:
        """Record delivery for ready messages of this channel not sent by the user.

        Returns only the ids that were newly marked, so callers broadcast status
        changes exactly once even if a client acks the same message repeatedly.
        """
        if not message_ids:
            return []
        eligible = select(Message.id, literal(user_id, type_=BigInteger)).where(
            Message.id.in_(message_ids),
            Message.channel_id == channel_id,
            Message.status == MessageStatus.READY.value,
            Message.sender_id != user_id,
        )
        stmt = (
            insert(MessageReceipt)
            .from_select(["message_id", "user_id"], eligible)
            .on_conflict_do_nothing(index_elements=["message_id", "user_id"])
            .returning(MessageReceipt.message_id)
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def mark_played(self, channel_id: int, user_id: int, message_id: uuid.UUID) -> bool:
        """Record playback (implies delivery). Returns True only on the first play."""
        message = await self.get(message_id)
        if (
            message is None
            or message.channel_id != channel_id
            or message.status != MessageStatus.READY.value
            or message.sender_id == user_id
        ):
            return False
        now = func.now()
        stmt = (
            insert(MessageReceipt)
            .values(message_id=message_id, user_id=user_id, played_at=now)
            .on_conflict_do_update(
                index_elements=["message_id", "user_id"],
                set_={"played_at": now},
                where=MessageReceipt.played_at.is_(None),
            )
            .returning(MessageReceipt.message_id)
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    # --- worker support -------------------------------------------------------
    async def lock_channel(self, channel_id: int) -> Channel:
        """SELECT ... FOR UPDATE on the channel row: serializes seq assignment."""
        result = await self.session.execute(
            select(Channel).where(Channel.id == channel_id).with_for_update()
        )
        return result.scalar_one()

    async def has_older_in_flight(self, message: Message, stale_before: datetime) -> bool:
        """Is an older message of the same channel still processing (and not stale)?"""
        result = await self.session.execute(
            select(func.count())
            .select_from(Message)
            .where(
                Message.channel_id == message.channel_id,
                Message.status == MessageStatus.PROCESSING.value,
                Message.id != message.id,
                Message.created_at > stale_before,
                or_(
                    Message.created_at < message.created_at,
                    and_(Message.created_at == message.created_at, Message.id < message.id),
                ),
            )
        )
        return int(result.scalar_one()) > 0

    async def fail_stale(self, stale_before: datetime) -> list[Message]:
        result = await self.session.execute(
            update(Message)
            .where(
                Message.status == MessageStatus.PROCESSING.value,
                Message.created_at < stale_before,
            )
            .values(status=MessageStatus.FAILED.value, error_code="PROCESSING_TIMEOUT")
            .returning(Message)
        )
        return list(result.scalars().all())
