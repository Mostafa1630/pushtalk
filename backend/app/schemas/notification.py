from datetime import datetime

from pydantic import BaseModel


class NotificationOut(BaseModel):
    id: int
    type: str  # channel_joined | channel_message
    title: str
    body: str
    related_id: int | None
    # Resolved at read time so the client can render localized text with the
    # current channel name / sender username (survives renames, i18n-friendly).
    channel_name: str | None = None
    actor_username: str | None = None
    is_read: bool
    created_at: datetime


class NotificationPage(BaseModel):
    notifications: list[NotificationOut]
    has_more: bool


class UnreadCount(BaseModel):
    count: int


class MarkedRead(BaseModel):
    count: int
