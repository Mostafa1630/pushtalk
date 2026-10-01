"""Authentication: registration, login, token validation and the error shape."""

from datetime import UTC, datetime, timedelta

import jwt
import pytest
from httpx import AsyncClient

from tests.conftest import bearer, register


async def test_register_returns_token_that_authenticates(client: AsyncClient) -> None:
    body = await register(client, "Alice")
    assert body["user"]["username"] == "alice"  # usernames are case-normalized
    assert body["token_type"] == "bearer" and body["expires_in"] > 0

    r = await client.get("/api/auth/me", headers=bearer(body["access_token"]))
    assert r.status_code == 200
    assert r.json() == {"id": body["user"]["id"], "username": "alice", "avatar_url": None}


async def test_password_is_hashed_not_stored(client: AsyncClient, session) -> None:  # type: ignore[no-untyped-def]
    from sqlalchemy import select

    from app.models import User

    await register(client, "hashme", "supersecret1")
    user = (await session.execute(select(User).where(User.username == "hashme"))).scalar_one()
    assert "supersecret1" not in user.password_hash
    assert user.password_hash.startswith("$2b$")  # bcrypt


async def test_duplicate_username_is_rejected_case_insensitively(client: AsyncClient) -> None:
    await register(client, "alice")
    r = await client.post("/api/auth/register", json={"username": "ALICE", "password": "password123"})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "USERNAME_TAKEN"


@pytest.mark.parametrize(
    ("payload", "field"),
    [
        ({"username": "ab", "password": "password123"}, "username"),  # too short
        ({"username": "bad name!", "password": "password123"}, "username"),  # invalid chars
        ({"username": "carol", "password": "short"}, "password"),  # too short
        ({"username": "carol"}, "password"),  # missing field
        ({"password": "password123"}, "username"),
    ],
)
async def test_register_validation_errors_have_consistent_shape(
    client: AsyncClient, payload: dict[str, str], field: str
) -> None:
    r = await client.post("/api/auth/register", json=payload)
    assert r.status_code == 422
    error = r.json()["error"]
    assert error["code"] == "VALIDATION_ERROR"
    assert any(d["field"] == field for d in error["details"])
    assert "request_id" in error


async def test_login_success_and_wrong_password(client: AsyncClient) -> None:
    await register(client, "dave", "correct-horse")
    ok = await client.post("/api/auth/login", json={"username": "Dave", "password": "correct-horse"})
    assert ok.status_code == 200 and ok.json()["access_token"]

    bad = await client.post("/api/auth/login", json={"username": "dave", "password": "wrong-horse"})
    assert bad.status_code == 401
    assert bad.json()["error"]["code"] == "INVALID_CREDENTIALS"


async def test_profile_username_update_and_duplicate_rejection(client: AsyncClient, alice, bob) -> None:  # type: ignore[no-untyped-def]
    headers = bearer(alice["access_token"])
    updated = await client.patch("/api/auth/me", json={"username": "Alice.New"}, headers=headers)
    assert updated.status_code == 200
    assert updated.json()["username"] == "alice.new"

    duplicate = await client.patch(
        "/api/auth/me", json={"username": bob["user"]["username"]}, headers=headers
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["error"]["code"] == "USERNAME_TAKEN"


async def test_password_change_requires_current_password_and_invalidates_old_one(
    client: AsyncClient, alice
) -> None:  # type: ignore[no-untyped-def]
    headers = bearer(alice["access_token"])
    wrong = await client.patch(
        "/api/auth/me/password",
        json={"current_password": "incorrect123", "new_password": "new-password"},
        headers=headers,
    )
    assert wrong.status_code == 422
    assert wrong.json()["error"]["code"] == "CURRENT_PASSWORD_INVALID"

    unchanged = await client.patch(
        "/api/auth/me/password",
        json={"current_password": "password123", "new_password": "password123"},
        headers=headers,
    )
    assert unchanged.status_code == 422
    assert unchanged.json()["error"]["code"] == "PASSWORD_UNCHANGED"

    changed = await client.patch(
        "/api/auth/me/password",
        json={"current_password": "password123", "new_password": "new-password"},
        headers=headers,
    )
    assert changed.status_code == 204

    old_login = await client.post(
        "/api/auth/login", json={"username": "alice", "password": "password123"}
    )
    new_login = await client.post(
        "/api/auth/login", json={"username": "alice", "password": "new-password"}
    )
    assert old_login.status_code == 401
    assert new_login.status_code == 200


async def test_unknown_user_gets_same_error_as_wrong_password(client: AsyncClient) -> None:
    r = await client.post("/api/auth/login", json={"username": "nobody", "password": "whatever1"})
    assert r.status_code == 401
    assert r.json()["error"] == {
        "code": "INVALID_CREDENTIALS",
        "message": "Invalid username or password",
        "request_id": r.headers["x-request-id"],
    }


async def test_missing_token_is_rejected(client: AsyncClient) -> None:
    r = await client.get("/api/channels")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "NOT_AUTHENTICATED"


async def test_malformed_token_is_rejected(client: AsyncClient) -> None:
    r = await client.get("/api/channels", headers=bearer("not.a.jwt"))
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "INVALID_TOKEN"


async def test_token_signed_with_another_secret_is_rejected(client: AsyncClient, alice) -> None:  # type: ignore[no-untyped-def]
    forged = jwt.encode(
        {"sub": str(alice["user"]["id"]), "type": "access", "exp": datetime.now(UTC) + timedelta(hours=1)},
        "attacker-secret-attacker-secret-attacker-secret",
        algorithm="HS256",
    )
    r = await client.get("/api/auth/me", headers=bearer(forged))
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "INVALID_TOKEN"


async def test_expired_token_is_rejected(client: AsyncClient, alice, settings) -> None:  # type: ignore[no-untyped-def]
    expired = jwt.encode(
        {"sub": str(alice["user"]["id"]), "type": "access", "exp": datetime.now(UTC) - timedelta(seconds=5)},
        settings.jwt_secret,
        algorithm="HS256",
    )
    r = await client.get("/api/auth/me", headers=bearer(expired))
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "TOKEN_EXPIRED"


async def test_alg_none_token_is_rejected(client: AsyncClient, alice) -> None:  # type: ignore[no-untyped-def]
    unsigned = jwt.encode(
        {"sub": str(alice["user"]["id"]), "type": "access", "exp": datetime.now(UTC) + timedelta(hours=1)},
        key=None,
        algorithm="none",
    )
    r = await client.get("/api/auth/me", headers=bearer(unsigned))
    assert r.status_code == 401
