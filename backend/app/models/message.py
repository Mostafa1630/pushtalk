import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, CreatedAtMixin


class MessageStatus(StrEnum):
    PROCESSING = "processing"  # uploaded + validated, waiting for / inside the worker
    READY = "ready"  # normalized, has a seq, broadcast to members ("sent")
    FAILED = "failed"  # processing failed; only the sender ever sees it


class Message(CreatedAtMixin, Base):
    __tablename__ = "messages"
    __table_args__ = (
        # Gap-free per-channel ordering key; NULL until the message is ready.
        UniqueConstraint("channel_id", "seq"),
        # Idempotent uploads: a retried upload with the same client_id is a no-op.
        UniqueConstraint("sender_id", "client_id"),
        CheckConstraint("status IN ('processing', 'ready', 'failed')", name="status_valid"),
        CheckConstraint("status <> 'ready' OR seq IS NOT NULL", name="ready_has_seq"),
        # Worker ordering check + stale sweeper: "older in-flight messages in this channel".
        Index("ix_messages_channel_id_status_created_at", "channel_id", "status", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    channel_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("channels.id", ondelete="CASCADE"), nullable=False
    )
    sender_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    client_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=MessageStatus.PROCESSING.value
    )
    seq: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    # --- upload metadata (detected server-side, never client-reported) ------
    upload_path: Mapped[str] = mapped_column(String(255), nullable=False)
    upload_mime: Mapped[str] = mapped_column(String(64), nullable=False)
    upload_bytes: Mapped[int] = mapped_column(Integer, nullable=False)

    # --- processed audio metadata (filled by the worker) --------------------
    audio_path: Mapped[str | None] = mapped_column(String(255), nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    waveform: Mapped[list[float] | None] = mapped_column(JSONB, nullable=True)

    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class MessageReceipt(Base):
    """Per-recipient delivery/playback state. One row per (message, recipient)."""

    __tablename__ = "message_receipts"

    message_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("messages.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    delivered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    played_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
