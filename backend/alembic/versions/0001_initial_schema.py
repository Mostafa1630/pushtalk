"""initial schema: users, channels, channel_members, messages, message_receipts

Revision ID: 0001
Revises:
Create Date: 2026-09-29 13:36:02.587554
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = '0001'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('users',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('username', sa.String(length=32), nullable=False),
    sa.Column('password_hash', sa.String(length=128), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_users')),
    sa.UniqueConstraint('username', name=op.f('uq_users_username'))
    )
    op.create_table('channels',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('name', sa.String(length=64), nullable=False),
    sa.Column('created_by', sa.BigInteger(), nullable=True),
    sa.Column('last_seq', sa.BigInteger(), server_default='0', nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], name=op.f('fk_channels_created_by_users'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_channels')),
    sa.UniqueConstraint('name', name=op.f('uq_channels_name'))
    )
    op.create_table('channel_members',
    sa.Column('channel_id', sa.BigInteger(), nullable=False),
    sa.Column('user_id', sa.BigInteger(), nullable=False),
    sa.Column('joined_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['channel_id'], ['channels.id'], name=op.f('fk_channel_members_channel_id_channels'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_channel_members_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('channel_id', 'user_id', name=op.f('pk_channel_members'))
    )
    op.create_index(op.f('ix_channel_members_user_id'), 'channel_members', ['user_id'], unique=False)
    op.create_table('messages',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('channel_id', sa.BigInteger(), nullable=False),
    sa.Column('sender_id', sa.BigInteger(), nullable=False),
    sa.Column('client_id', sa.UUID(), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('seq', sa.BigInteger(), nullable=True),
    sa.Column('upload_path', sa.String(length=255), nullable=False),
    sa.Column('upload_mime', sa.String(length=64), nullable=False),
    sa.Column('upload_bytes', sa.Integer(), nullable=False),
    sa.Column('audio_path', sa.String(length=255), nullable=True),
    sa.Column('duration_ms', sa.Integer(), nullable=True),
    sa.Column('waveform', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('error_code', sa.String(length=64), nullable=True),
    sa.Column('processed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("status <> 'ready' OR seq IS NOT NULL", name=op.f('ck_messages_ready_has_seq')),
    sa.CheckConstraint("status IN ('processing', 'ready', 'failed')", name=op.f('ck_messages_status_valid')),
    sa.ForeignKeyConstraint(['channel_id'], ['channels.id'], name=op.f('fk_messages_channel_id_channels'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['sender_id'], ['users.id'], name=op.f('fk_messages_sender_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_messages')),
    sa.UniqueConstraint('channel_id', 'seq', name=op.f('uq_messages_channel_id_seq')),
    sa.UniqueConstraint('sender_id', 'client_id', name=op.f('uq_messages_sender_id_client_id'))
    )
    op.create_index('ix_messages_channel_id_status_created_at', 'messages', ['channel_id', 'status', 'created_at'], unique=False)
    op.create_table('message_receipts',
    sa.Column('message_id', sa.UUID(), nullable=False),
    sa.Column('user_id', sa.BigInteger(), nullable=False),
    sa.Column('delivered_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('played_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['message_id'], ['messages.id'], name=op.f('fk_message_receipts_message_id_messages'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_message_receipts_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('message_id', 'user_id', name=op.f('pk_message_receipts'))
    )
    op.create_index(op.f('ix_message_receipts_user_id'), 'message_receipts', ['user_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_message_receipts_user_id'), table_name='message_receipts')
    op.drop_table('message_receipts')
    op.drop_index('ix_messages_channel_id_status_created_at', table_name='messages')
    op.drop_table('messages')
    op.drop_index(op.f('ix_channel_members_user_id'), table_name='channel_members')
    op.drop_table('channel_members')
    op.drop_table('channels')
    op.drop_table('users')
