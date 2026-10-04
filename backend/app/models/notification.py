from sqlalchemy import BigInteger, Boolean, ForeignKey, Identity, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, CreatedAtMixin


class Notification(CreatedAtMixin, Base):
    __tablename__ = "notifications"
    __table_args__ = (Index("ix_notifications_user_id_is_read", "user_id", "is_read"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    # The recipient: notifications are strictly per-user.
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # "channel_joined" | "channel_message"; the client renders localized text per type.
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    # Canonical English text; also the fallback when the client can't localize.
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    body: Mapped[str] = mapped_column(String(300), nullable=False)
    # The channel the notification is about (both current types relate to a channel).
    related_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # Who caused it: the joiner / the message sender.
    actor_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    is_read: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=func.false()
    )
