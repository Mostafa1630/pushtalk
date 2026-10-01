"""user avatars, channel description and image

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-01 02:18:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("avatar_path", sa.String(length=255), nullable=True))
    op.add_column(
        "channels",
        sa.Column("description", sa.String(length=200), server_default="", nullable=False),
    )
    op.add_column("channels", sa.Column("image_path", sa.String(length=255), nullable=True))


def downgrade() -> None:
    op.drop_column("channels", "image_path")
    op.drop_column("channels", "description")
    op.drop_column("users", "avatar_path")
