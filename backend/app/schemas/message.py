import uuid
from datetime import datetime

from pydantic import BaseModel


class ReceiptSummary(BaseModel):
    """Aggregated status for the sender: how many recipients got / played it."""

    recipients: int
    delivered: int
    played: int


class MessageOut(BaseModel):
    id: uuid.UUID
    client_id: uuid.UUID
    channel_id: int
    sender_id: int
    sender_username: str
    sender_avatar_url: str | None = None
    status: str  # processing | ready | failed
    seq: int | None
    duration_ms: int | None
    waveform: list[float] | None
    # Filled by a second worker step, so it can be missing at first and arrive
    # later as a `message.transcript` event.
    transcript: str | None = None
    error_code: str | None
    created_at: datetime
    # Only filled for the requesting user's own messages.
    receipts: ReceiptSummary | None = None
    # Whether the requesting user has already played this message.
    played_by_me: bool = False


class MessagePage(BaseModel):
    messages: list[MessageOut]
    # Latest seq in the channel at query time. The client compares it with its
    # own last seen seq to know whether more catch-up pages are needed.
    latest_seq: int
    has_more: bool
