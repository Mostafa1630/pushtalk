from sqlalchemy import BigInteger, Identity, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, CreatedAtMixin


class User(CreatedAtMixin, Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    # Stored lower-cased by the service layer; unique constraint enforces
    # case-insensitive uniqueness ("Alice" and "alice" are the same user).
    username: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    avatar_path: Mapped[str | None] = mapped_column(String(255), nullable=True)
