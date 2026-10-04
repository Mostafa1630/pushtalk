from dataclasses import dataclass

from sqlalchemy import Select, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Channel, Notification, User


@dataclass(frozen=True)
class NotificationRow:
    notification: Notification
    channel_name: str | None
    actor_username: str | None


class NotificationRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    def add(self, notification: Notification) -> None:
        self.session.add(notification)

    def _joined(self) -> Select[tuple[Notification, str | None, str | None]]:
        return (
            select(Notification, Channel.name, User.username)
            .outerjoin(Channel, Channel.id == Notification.related_id)
            .outerjoin(User, User.id == Notification.actor_id)
        )

    async def list_for_user(
        self, user_id: int, *, before_id: int | None, limit: int
    ) -> tuple[list[NotificationRow], bool]:
        """Newest first, keyset-paginated on id, plus whether an older page exists."""
        query = self._joined().where(Notification.user_id == user_id)
        if before_id is not None:
            query = query.where(Notification.id < before_id)
        result = await self.session.execute(query.order_by(Notification.id.desc()).limit(limit + 1))
        rows = [NotificationRow(n, name, username) for n, name, username in result.all()]
        has_more = len(rows) > limit
        return rows[:limit], has_more

    async def get_row(self, user_id: int, notification_id: int) -> NotificationRow | None:
        result = await self.session.execute(
            self._joined().where(Notification.id == notification_id, Notification.user_id == user_id)
        )
        row = result.one_or_none()
        return None if row is None else NotificationRow(*row)

    async def unread_count(self, user_id: int) -> int:
        result = await self.session.execute(
            select(func.count())
            .select_from(Notification)
            .where(Notification.user_id == user_id, Notification.is_read.is_(False))
        )
        return int(result.scalar_one())

    async def mark_read(self, user_id: int, notification_id: int) -> NotificationRow | None:
        """Mark owned notification read; None if it doesn't belong to the user."""
        row = await self.get_row(user_id, notification_id)
        if row is None:
            return None
        row.notification.is_read = True
        return row

    async def mark_all_read(self, user_id: int) -> int:
        """Returns how many rows were actually flipped from unread."""
        stmt = (
            update(Notification)
            .where(Notification.user_id == user_id, Notification.is_read.is_(False))
            .values(is_read=True)
        )
        result = await self.session.execute(stmt)
        return result.rowcount or 0
