"""Rate limiting tests: per-user isolation, upload budgets, 429 responses, and headers."""

import uuid
from httpx import AsyncClient

from tests.conftest import bearer


async def test_rate_limit_headers_on_success(client: AsyncClient, alice) -> None:
    res = await client.get("/api/channels", headers=bearer(alice["access_token"]))
    assert res.status_code == 200
    assert "X-RateLimit-Limit" in res.headers
    assert "X-RateLimit-Remaining" in res.headers
    assert "X-RateLimit-Reset" in res.headers


async def test_rate_limit_exceeded_returns_429(
    client: AsyncClient, alice, monkeypatch
) -> None:
    # Lower the general limit to 3 requests
    settings = client.app.state.redis  # verify redis exists
    from app.core import config
    settings_obj = config.get_settings().model_copy(
        update={"rate_limit_requests": 3, "rate_limit_window_seconds": 60}
    )

    from app.core import rate_limit
    orig_middleware = rate_limit.rate_limit_middleware

    async def patched_middleware(request, call_next, _):
        return await orig_middleware(request, call_next, settings_obj)

    monkeypatch.setattr(rate_limit, "rate_limit_middleware", patched_middleware)

    # 1st request - ok
    r1 = await client.get("/api/auth/me", headers=bearer(alice["access_token"]))
    assert r1.status_code == 200
    assert r1.headers["X-RateLimit-Remaining"] == "2"

    # 2nd request - ok
    r2 = await client.get("/api/auth/me", headers=bearer(alice["access_token"]))
    assert r2.status_code == 200
    assert r2.headers["X-RateLimit-Remaining"] == "1"

    # 3rd request - ok
    r3 = await client.get("/api/auth/me", headers=bearer(alice["access_token"]))
    assert r3.status_code == 200
    assert r3.headers["X-RateLimit-Remaining"] == "0"

    # 4th request - RATE LIMITED (429)
    r4 = await client.get("/api/auth/me", headers=bearer(alice["access_token"]))
    assert r4.status_code == 429
    assert "Retry-After" in r4.headers
    assert r4.json()["error"]["code"] == "RATE_LIMITED"


async def test_per_user_isolation(client: AsyncClient, alice, bob, monkeypatch) -> None:
    from app.core import config, rate_limit

    settings_obj = config.get_settings().model_copy(
        update={"rate_limit_requests": 2, "rate_limit_window_seconds": 60}
    )
    orig_middleware = rate_limit.rate_limit_middleware

    async def patched_middleware(request, call_next, _):
        return await orig_middleware(request, call_next, settings_obj)

    monkeypatch.setattr(rate_limit, "rate_limit_middleware", patched_middleware)

    # Alice exhausts her quota
    await client.get("/api/auth/me", headers=bearer(alice["access_token"]))
    await client.get("/api/auth/me", headers=bearer(alice["access_token"]))
    r_alice = await client.get("/api/auth/me", headers=bearer(alice["access_token"]))
    assert r_alice.status_code == 429

    # Bob's requests must still succeed!
    r_bob = await client.get("/api/auth/me", headers=bearer(bob["access_token"]))
    assert r_bob.status_code == 200


async def test_upload_rate_limit(
    client: AsyncClient, alice, channel, make_audio, monkeypatch
) -> None:
    from app.core import config, rate_limit

    # Set upload limit to 1
    settings_obj = config.get_settings().model_copy(
        update={"upload_limit_requests": 1, "upload_limit_window_seconds": 60}
    )
    orig_middleware = rate_limit.rate_limit_middleware

    async def patched_middleware(request, call_next, _):
        return await orig_middleware(request, call_next, settings_obj)

    monkeypatch.setattr(rate_limit, "rate_limit_middleware", patched_middleware)

    # First upload - accepted
    r1 = await client.post(
        f"/api/channels/{channel['id']}/messages",
        headers=bearer(alice["access_token"]),
        files={"file": ("r1.webm", make_audio("rl_ok1.webm", 1.0), "audio/webm")},
        data={"client_id": str(uuid.uuid4())},
    )
    assert r1.status_code == 202

    # Second upload - rate limited!
    r2 = await client.post(
        f"/api/channels/{channel['id']}/messages",
        headers=bearer(alice["access_token"]),
        files={"file": ("r2.webm", make_audio("rl_ok2.webm", 1.0), "audio/webm")},
        data={"client_id": str(uuid.uuid4())},
    )
    assert r2.status_code == 429
    assert r2.json()["error"]["code"] == "RATE_LIMITED"
