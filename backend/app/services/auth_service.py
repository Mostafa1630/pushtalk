"""Registration, login and profile photo."""

import logging

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, PayloadTooLarge, Unauthorized, UnsupportedMedia, ValidationFailed
from app.core.security import (
    DUMMY_PASSWORD_HASH,
    create_access_token,
    hash_password,
    verify_password,
)
from app.images import MAX_IMAGE_BYTES, extension_for, sniff_image
from app.models import User
from app.repositories.users import UserRepository
from app.schemas.auth import Credentials, PasswordChange, TokenOut, UserOut, UserUpdate
from app.storage.local import LocalStorage, StorageError
from app.core.errors import ServiceUnavailable

logger = logging.getLogger("app.auth")


def user_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        username=user.username,
        avatar_url=f"/api/users/{user.id}/avatar" if user.avatar_path else None,
    )


def _token_response(user: User) -> TokenOut:
    token, expires_in = create_access_token(user.id, user.username)
    return TokenOut(access_token=token, expires_in=expires_in, user=user_out(user))


async def register(session: AsyncSession, creds: Credentials) -> TokenOut:
    users = UserRepository(session)
    if await users.get_by_username(creds.username) is not None:
        raise Conflict("Username is already taken", code="USERNAME_TAKEN")
    try:
        user = await users.add(creds.username, hash_password(creds.password))
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise Conflict("Username is already taken", code="USERNAME_TAKEN") from exc
    logger.info("user_registered", extra={"user_id": user.id})
    return _token_response(user)


async def login(session: AsyncSession, creds: Credentials) -> TokenOut:
    user = await UserRepository(session).get_by_username(creds.username)
    password_ok = verify_password(creds.password, user.password_hash if user else DUMMY_PASSWORD_HASH)
    if user is None or not password_ok:
        logger.info("login_failed", extra={"username": creds.username})
        raise Unauthorized("Invalid username or password", code="INVALID_CREDENTIALS")
    logger.info("login_succeeded", extra={"user_id": user.id})
    return _token_response(user)


async def update_profile(session: AsyncSession, user: User, data: UserUpdate) -> UserOut:
    if data.username != user.username:
        existing = await UserRepository(session).get_by_username(data.username)
        if existing is not None and existing.id != user.id:
            raise Conflict("Username is already taken", code="USERNAME_TAKEN")
        user.username = data.username
        try:
            await session.commit()
        except IntegrityError as exc:
            await session.rollback()
            raise Conflict("Username is already taken", code="USERNAME_TAKEN") from exc
        await session.refresh(user)
    return user_out(user)


async def change_password(
    session: AsyncSession, user: User, data: PasswordChange
) -> None:
    if not verify_password(data.current_password, user.password_hash):
        raise ValidationFailed(
            "Current password is incorrect", code="CURRENT_PASSWORD_INVALID"
        )
    if data.current_password == data.new_password:
        raise ValidationFailed(
            "New password must differ from the current password",
            code="PASSWORD_UNCHANGED",
        )
    user.password_hash = hash_password(data.new_password)
    session.add(user)
    await session.commit()


async def set_avatar(session: AsyncSession, storage: LocalStorage, user: User, data: bytes) -> UserOut:
    if not data:
        raise UnsupportedMedia("Image is empty", code="EMPTY_FILE")
    if len(data) > MAX_IMAGE_BYTES:
        raise PayloadTooLarge("Profile photo must be 2 MB or smaller")
    mime = sniff_image(data[:16])
    if mime is None:
        raise UnsupportedMedia("Use a JPEG, PNG or WebP photo", code="UNRECOGNIZED_IMAGE")
    key = storage.avatar_key(user.id, extension_for(mime))
    try:
        storage.write_bytes(key, data)
    except StorageError as exc:
        raise ServiceUnavailable("Could not store the photo", code="STORAGE_UNAVAILABLE") from exc
    if user.avatar_path and user.avatar_path != key:
        storage.delete(user.avatar_path)
    user.avatar_path = key
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return user_out(user)
