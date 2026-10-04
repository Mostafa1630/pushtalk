"""Notifications: creation on join/message, realtime push, read endpoints."""

import json
import uuid
from typing import Any

from httpx import AsyncClient

from app.db.session import SessionLocal
from app.worker import tasks
from tests.conftest import FakeRedis, bearer


def _user_events(fake_redis: FakeRedis, user_id: int) -> list[dict[str, Any]]:
    return [
        json.loads(data)
        for topic, data in fake_redis.published
        if topic == f"pushtalk:user:{user_id}"
    ]


def _ctx(settings, storage, fake_redis) -> dict[str, Any]:  # type: ignore[no-untyped-def]
    return {
        "settings": settings,
        "session_factory": SessionLocal,
        "storage": storage,
        "redis": fake_redis,
        "job_try": 1,
    }


async def _ready_message(client: AsyncClient, token: str, channel_id: int, audio: bytes, ctx: dict[str, Any]) -> str:  # type: ignore[no-untyped-def]
    r = await client.post(
        f"/api/channels/{channel_id}/messages",
        headers=bearer(token),
        files={"file": ("r.webm", audio, "audio/webm")},
        data={"client_id": str(uuid.uuid4())},
    )
    assert r.status_code == 202, r.text
    assert await tasks.process_message(ctx, r.json()["id"]) == "ready"
    return r.json()["id"]


async def _list(client: AsyncClient, token: str, **params: Any) -> dict[str, Any]:  # type: ignore[no-untyped-def]
    r = await client.get("/api/notifications", params=params, headers=bearer(token))
    assert r.status_code == 200, r.text
    return r.json()


async def test_joining_creates_congratulation_notification_and_pushes_it(
    client: AsyncClient, alice, bob, channel, fake_redis
) -> None:  # type: ignore[no-untyped-def]
    page = await _list(client, bob["access_token"])
    [n] = page["notifications"]
    assert page["has_more"] is False
    assert n["type"] == "channel_joined"
    assert n["related_id"] == channel["id"] and n["channel_name"] == channel["name"]
    assert n["actor_username"] == "bob" and n["is_read"] is False
    assert channel["name"] in n["body"]  # English fallback text

    [event] = _user_events(fake_redis, bob["user"]["id"])
    assert event["type"] == "notification.new"
    assert event["notification"]["id"] == n["id"] and event["notification"]["type"] == "channel_joined"


async def test_rejoining_does_not_duplicate_the_notification(
    client: AsyncClient, bob, channel, fake_redis
) -> None:  # type: ignore[no-untyped-def]
    again = await client.post(f"/api/channels/{channel['id']}/join", headers=bearer(bob["access_token"]))
    assert again.status_code == 200
    page = await _list(client, bob["access_token"])
    assert len(page["notifications"]) == 1
    assert len(_user_events(fake_redis, bob["user"]["id"])) == 1


async def test_message_in_owned_channel_notifies_the_owner_not_the_sender(
    client: AsyncClient, alice, bob, channel, settings, storage, fake_redis, make_audio
) -> None:  # type: ignore[no-untyped-def]
    await _ready_message(
        client, bob["access_token"], channel["id"], make_audio("ok1.webm", 1.0), _ctx(settings, storage, fake_redis)
    )

    page = await _list(client, alice["access_token"])  # alice created the channel
    [n] = page["notifications"]
    assert n["type"] == "channel_message"
    assert n["channel_name"] == channel["name"] and n["actor_username"] == "bob"
    assert n["is_read"] is False

    [event] = _user_events(fake_redis, alice["user"]["id"])
    assert event["type"] == "notification.new"
    assert event["notification"]["id"] == n["id"] and event["notification"]["type"] == "channel_message"

    # The sender is not notified about their own message (only their earlier join).
    bob_page = await _list(client, bob["access_token"])
    assert [m["type"] for m in bob_page["notifications"]] == ["channel_joined"]


async def test_sender_who_owns_the_channel_is_not_notified(
    client: AsyncClient, alice, channel, settings, storage, fake_redis, make_audio
) -> None:  # type: ignore[no-untyped-def]
    await _ready_message(
        client, alice["access_token"], channel["id"], make_audio("ok1.webm", 1.0), _ctx(settings, storage, fake_redis)
    )
    page = await _list(client, alice["access_token"])
    assert page["notifications"] == []
    assert _user_events(fake_redis, alice["user"]["id"]) == []


async def test_unread_count_mark_read_and_ownership(
    client: AsyncClient, alice, bob, channel
) -> None:  # type: ignore[no-untyped-def]
    r = await client.post("/api/channels", json={"name": "random"}, headers=bearer(alice["access_token"]))
    assert r.status_code == 201, r.text
    await client.post(f"/api/channels/{r.json()['id']}/join", headers=bearer(bob["access_token"]))

    async def unread() -> int:
        res = await client.get("/api/notifications/unread-count", headers=bearer(bob["access_token"]))
        assert res.status_code == 200, res.text
        return res.json()["count"]

    assert await unread() == 2
    page = await _list(client, bob["access_token"])
    newest, oldest = page["notifications"][0], page["notifications"][-1]
    assert newest["id"] > oldest["id"]  # newest first
    assert newest["channel_name"] == "random"  # joined `random` after `general`

    # Another user's notification is invisible (and unreadable).
    foreign = await client.post(f"/api/notifications/{oldest['id']}/read", headers=bearer(alice["access_token"]))
    assert foreign.status_code == 404 and foreign.json()["error"]["code"] == "NOTIFICATION_NOT_FOUND"

    marked = await client.post(f"/api/notifications/{newest['id']}/read", headers=bearer(bob["access_token"]))
    assert marked.status_code == 200, marked.text
    assert marked.json()["is_read"] is True
    assert await unread() == 1

    # Idempotent: re-reading keeps it read.
    again = await client.post(f"/api/notifications/{newest['id']}/read", headers=bearer(bob["access_token"]))
    assert again.status_code == 200 and again.json()["is_read"] is True
    assert await unread() == 1

    # Anonymous access is rejected.
    assert (await client.get("/api/notifications")).status_code == 401


async def test_pagination_and_mark_all_read(
    client: AsyncClient, alice, bob, channel
) -> None:  # type: ignore[no-untyped-def]
    for name in ("c2", "c3", "c4", "c5"):  # bob already joined `general` in the fixture
        r = await client.post("/api/channels", json={"name": name}, headers=bearer(alice["access_token"]))
        assert r.status_code == 201, r.text
        joined = await client.post(f"/api/channels/{r.json()['id']}/join", headers=bearer(bob["access_token"]))
        assert joined.status_code == 200

    token = bob["access_token"]
    p1 = await _list(client, token, limit=2)
    p2 = await _list(client, token, limit=2, before_id=p1["notifications"][-1]["id"])
    p3 = await _list(client, token, limit=2, before_id=p2["notifications"][-1]["id"])
    ids = [n["id"] for n in p1["notifications"] + p2["notifications"] + p3["notifications"]]
    assert len(ids) == 5 and len(set(ids)) == 5  # no overlap, all delivered
    assert ids == sorted(ids, reverse=True)
    assert (p1["has_more"], p2["has_more"], p3["has_more"]) == (True, True, False)
    assert len(p3["notifications"]) == 1  # 5 items in pages of 2: 2 + 2 + 1
    res = await client.post("/api/notifications/read-all", headers=bearer(token))
    assert res.status_code == 200 and res.json()["count"] == 5
    page = await _list(client, token)
    assert all(n["is_read"] for n in page["notifications"])
    assert (await client.get("/api/notifications/unread-count", headers=bearer(token))).json()["count"] == 0

    # Nothing left to read.
    res = await client.post("/api/notifications/read-all", headers=bearer(token))
    assert res.json()["count"] == 0
