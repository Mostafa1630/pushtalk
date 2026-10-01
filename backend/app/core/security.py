"""Password hashing (bcrypt) and JWT access tokens."""

from datetime import UTC, datetime, timedelta

import bcrypt
import jwt

from app.core.config import get_settings
from app.core.errors import Unauthorized

# bcrypt only looks at the first 72 bytes; the schema caps passwords at 72 bytes
# so two different passwords can never collide silently.
BCRYPT_MAX_BYTES = 72


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("ascii")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("ascii"))
    except ValueError:
        return False


# A valid hash of a random string, used to spend the same CPU time on unknown
# usernames as on known ones (prevents username enumeration via timing).
DUMMY_PASSWORD_HASH = hash_password("pushtalk-timing-equalizer")


def create_access_token(user_id: int, username: str) -> tuple[str, int]:
    """Return (token, expires_in_seconds)."""
    settings = get_settings()
    expires_in = settings.access_token_expire_minutes * 60
    now = datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "username": username,
        "iat": now,
        "exp": now + timedelta(seconds=expires_in),
        "type": "access",
    }
    token = jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)
    return token, expires_in


def decode_access_token(token: str) -> int:
    """Validate a token and return the user id. Raises Unauthorized."""
    settings = get_settings()
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],
            options={"require": ["exp", "sub"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise Unauthorized("Session expired, please log in again", code="TOKEN_EXPIRED") from exc
    except jwt.PyJWTError as exc:
        raise Unauthorized("Invalid authentication token", code="INVALID_TOKEN") from exc
    if payload.get("type") != "access":
        raise Unauthorized("Invalid authentication token", code="INVALID_TOKEN")
    try:
        return int(payload["sub"])
    except (TypeError, ValueError) as exc:
        raise Unauthorized("Invalid authentication token", code="INVALID_TOKEN") from exc
