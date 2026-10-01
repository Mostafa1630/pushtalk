"""Channel membership, history/catch-up paging and protected media access."""

import uuid
from typing import Any

from httpx import AsyncClient

from app.db.session import SessionLocal
from app.worker import tasks
from tests.conftest import bearer, register


async def _ready_message(client: AsyncClient, token: str, channel_id: int, audio: bytes, ctx: dict[str, Any]) -> str:
    r = await client.post(
        f"/api/channels/{channel_id}/messages",
        headers=bearer(token),
        files={"file": ("r.webm", audio, "audio/webm")},
        data={"client_id": str(uuid.uuid4())},
    )
    assert r.status_code == 202, r.text
    assert await tasks.process_message(ctx, r.json()["id"]) == "ready"
    return r.json()["id"]


def _ctx(settings, storage, fake_redis) -> dict[str, Any]:  # type: ignore[no-untyped-def]
    return {"settings": settings, "session_factory": SessionLocal, "storage": storage, "redis": fake_redis, "job_try": 1}


async def test_create_duplicate_and_join_missing_channel(client: AsyncClient, alice) -> None:  # type: ignore[no-untyped-def]
    token = alice["access_token"]
    assert (await client.post("/api/channels", json={"name": "Team-A"}, headers=bearer(token))).status_code == 201
    dup = await client.post("/api/channels", json={"name": "team-a"}, headers=bearer(token))
    assert dup.status_code == 409 and dup.json()["error"]["code"] == "CHANNEL_EXISTS"
    missing = await client.post("/api/channels/999/join", headers=bearer(token))
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "CHANNEL_NOT_FOUND"
    bad = await client.post("/api/channels", json={"name": "no spaces!"}, headers=bearer(token))
    assert bad.status_code == 422


async def test_join_is_idempotent_and_listing_shows_membership(client: AsyncClient, alice, bob, channel) -> None:  # type: ignore[no-untyped-def]
    again = await client.post(f"/api/channels/{channel['id']}/join", headers=bearer(bob["access_token"]))
    assert again.status_code == 200 and again.json()["member_count"] == 2
    carol = await register(client, "carol")
    listing = await client.get("/api/channels", headers=bearer(carol["access_token"]))
    [row] = listing.json()
    assert row["is_member"] is False and row["member_count"] == 2


async def test_history_requires_membership(client: AsyncClient, channel) -> None:  # type: ignore[no-untyped-def]
    carol = await register(client, "carol")
    r = await client.get(f"/api/channels/{channel['id']}/messages", headers=bearer(carol["access_token"]))
    assert r.status_code == 403 and r.json()["error"]["code"] == "NOT_A_MEMBER"


async def test_catch_up_after_seq_returns_missed_messages_in_order(
    client: AsyncClient, alice, bob, channel, settings, storage, fake_redis, make_audio
) -> None:  # type: ignore[no-untyped-def]
    ctx = _ctx(settings, storage, fake_redis)
    ids = [await _ready_message(client, alice["access_token"], channel["id"], make_audio("ok1.webm", 1.0), ctx)
           for _ in range(3)]

    # Bob last saw seq 1 -> he gets seq 2 and 3, oldest first.
    r = await client.get(
        f"/api/channels/{channel['id']}/messages", params={"after_seq": 1}, headers=bearer(bob["access_token"])
    )
    page = r.json()
    assert [m["id"] for m in page["messages"]] == ids[1:]
    assert [m["seq"] for m in page["messages"]] == [2, 3]
    assert page["latest_seq"] == 3 and page["has_more"] is False

    # Paging: limit=1 reports has_more so the client keeps fetching.
    r = await client.get(
        f"/api/channels/{channel['id']}/messages", params={"after_seq": 0, "limit": 1},
        headers=bearer(bob["access_token"]),
    )
    assert r.json()["has_more"] is True and r.json()["messages"][0]["seq"] == 1


async def test_sender_sees_own_failed_message_in_history_but_others_do_not(
    client: AsyncClient, alice, bob, channel, queue
) -> None:  # type: ignore[no-untyped-def]
    queue.fail = True
    import subprocess

    audio = subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=duration=1", "-c:a", "libopus", "-f", "webm", "-"],
        capture_output=True, check=True,
    ).stdout
    r = await client.post(
        f"/api/channels/{channel['id']}/messages", headers=bearer(alice["access_token"]),
        files={"file": ("r.webm", audio, "audio/webm")}, data={"client_id": str(uuid.uuid4())},
    )
    assert r.status_code == 503
    mine = (await client.get(f"/api/channels/{channel['id']}/messages", headers=bearer(alice["access_token"]))).json()
    theirs = (await client.get(f"/api/channels/{channel['id']}/messages", headers=bearer(bob["access_token"]))).json()
    assert [m["status"] for m in mine["messages"]] == ["failed"]
    assert theirs["messages"] == []


async def test_only_members_can_fetch_audio(
    client: AsyncClient, alice, bob, channel, settings, storage, fake_redis, make_audio
) -> None:  # type: ignore[no-untyped-def]
    mid = await _ready_message(client, alice["access_token"], channel["id"], make_audio("ok1.webm", 1.0),
                               _ctx(settings, storage, fake_redis))

    ok = await client.get(f"/api/messages/{mid}/audio", headers=bearer(bob["access_token"]))
    assert ok.status_code == 200
    assert ok.headers["content-type"] == "audio/ogg" and ok.content[:4] == b"OggS"
    assert "private" in ok.headers["cache-control"]

    outsider = await register(client, "mallory")
    denied = await client.get(f"/api/messages/{mid}/audio", headers=bearer(outsider["access_token"]))
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "NOT_A_MEMBER"

    anonymous = await client.get(f"/api/messages/{mid}/audio")
    assert anonymous.status_code == 401

    unknown = await client.get(f"/api/messages/{uuid.uuid4()}/audio", headers=bearer(bob["access_token"]))
    assert unknown.status_code == 404


async def test_audio_of_unprocessed_message_is_not_served(client: AsyncClient, alice, bob, channel, make_audio) -> None:  # type: ignore[no-untyped-def]
    r = await client.post(
        f"/api/channels/{channel['id']}/messages", headers=bearer(alice["access_token"]),
        files={"file": ("r.webm", make_audio("ok1.webm", 1.0), "audio/webm")}, data={"client_id": str(uuid.uuid4())},
    )
    denied = await client.get(f"/api/messages/{r.json()['id']}/audio", headers=bearer(bob["access_token"]))
    assert denied.status_code == 404 and denied.json()["error"]["code"] == "AUDIO_NOT_READY"


async def test_receipts_are_idempotent_and_counted(
    client: AsyncClient, alice, bob, channel, settings, storage, fake_redis, make_audio
) -> None:  # type: ignore[no-untyped-def]
    from app.services import message_service

    mid = await _ready_message(client, alice["access_token"], channel["id"], make_audio("ok1.webm", 1.0),
                               _ctx(settings, storage, fake_redis))
    fake_redis.published.clear()
    async with SessionLocal() as s:
        for _ in range(2):  # duplicate acks (e.g. two tabs) publish only once
            await message_service.record_delivered(s, fake_redis, bob["user"]["id"], channel["id"], [uuid.UUID(mid)])
        await message_service.record_played(s, fake_redis, bob["user"]["id"], channel["id"], uuid.UUID(mid))
        await message_service.record_played(s, fake_redis, bob["user"]["id"], channel["id"], uuid.UUID(mid))
        # The sender acking their own message is ignored.
        await message_service.record_played(s, fake_redis, alice["user"]["id"], channel["id"], uuid.UUID(mid))
    assert len(fake_redis.published) == 2

    page = (await client.get(f"/api/channels/{channel['id']}/messages", headers=bearer(alice["access_token"]))).json()
    assert page["messages"][0]["receipts"] == {"recipients": 1, "delivered": 1, "played": 1}
    bob_page = (await client.get(f"/api/channels/{channel['id']}/messages", headers=bearer(bob["access_token"]))).json()
    assert bob_page["messages"][0]["played_by_me"] is True and bob_page["messages"][0]["receipts"] is None
