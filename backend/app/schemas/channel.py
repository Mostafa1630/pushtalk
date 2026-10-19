import re
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

CHANNEL_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,63}$")


class ChannelCreate(BaseModel):
    name: str = Field(min_length=2, max_length=64)
    description: str = Field(default="", max_length=200)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        value = value.strip().lower()
        if not CHANNEL_RE.fullmatch(value):
            raise ValueError(
                "Channel name must be 2-64 characters: lowercase letters, digits, '_' or '-'"
            )
        return value

    @field_validator("description")
    @classmethod
    def _description(cls, value: str) -> str:
        return value.strip()


class ChannelUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=64)
    description: str | None = Field(default=None, max_length=200)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip().lower()
        if not CHANNEL_RE.fullmatch(value):
            raise ValueError(
                "Channel name must be 2-64 characters: lowercase letters, digits, '_' or '-'"
            )
        return value

    @field_validator("description")
    @classmethod
    def _description(cls, value: str | None) -> str | None:
        return None if value is None else value.strip()


class ChannelOut(BaseModel):
    id: int
    name: str
    description: str
    created_at: datetime
    created_by: int | None
    member_count: int
    is_member: bool
    is_owner: bool
    image_url: str | None
    is_direct: bool = False
    dm_user_id: int | None = None


class DirectChannelCreate(BaseModel):
    user_id: int | None = None
    username: str | None = None


class MemberOut(BaseModel):
    user_id: int
    username: str
    online: bool
    joined_at: datetime
    avatar_url: str | None
