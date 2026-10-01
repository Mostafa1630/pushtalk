from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Identity, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, CreatedAtMixin


class Channel(CreatedAtMixin, Base):
    __tablename__ = "channels"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    # Stored lower-cased; unique so two channels can't share a name.
    name: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    description: Mapped[str] = mapped_column(String(200), nullable=False, server_default="")
    image_path: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # Per-channel sequence counter. The worker increments it under a row lock
    # when a message becomes ready, so every ready message gets a gap-free,
    # strictly increasing `seq` that defines the order clients play in.
    last_seq: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")


class ChannelMember(Base):
    __tablename__ = "channel_members"

    channel_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("channels.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
