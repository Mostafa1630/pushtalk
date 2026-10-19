"""Direct messages tests: creation, idempotency, privacy, and voice message exchange."""

import uuid
from httpx import AsyncClient

from tests.conftest import bearer


async def test_create_and_get_dm(client: AsyncClient, alice, bob) -> None:
    # Alice starts a DM with Bob by user_id
    res = await client.post(
        "/api/channels/direct",
        headers=bearer(alice["access_token"]),
        json={"user_id": bob["user"]["id"]},
    )
    assert res.status_code == 200, res.text
    dm = res.json()
    assert dm["is_direct"] is True
    assert dm["name"] == bob["user"]["username"]
    assert dm["dm_user_id"] == bob["user"]["id"]
    dm_id = dm["id"]

    # Bob fetches the same DM channel
    res_bob = await client.get(f"/api/channels/{dm_id}", headers=bearer(bob["access_token"]))
    assert res_bob.status_code == 200
    dm_bob = res_bob.json()
    assert dm_bob["is_direct"] is True
    assert dm_bob["name"] == alice["user"]["username"]
    assert dm_bob["dm_user_id"] == alice["user"]["id"]

    # Bob starts DM with Alice by username: returns the SAME channel
    res_repeat = await client.post(
        "/api/channels/direct",
        headers=bearer(bob["access_token"]),
        json={"username": alice["user"]["username"]},
    )
    assert res_repeat.status_code == 200
    assert res_repeat.json()["id"] == dm_id


async def test_cannot_dm_self_or_nonexistent_user(client: AsyncClient, alice) -> None:
    # Cannot message self
    res = await client.post(
        "/api/channels/direct",
        headers=bearer(alice["access_token"]),
        json={"user_id": alice["user"]["id"]},
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "SELF_DM_NOT_ALLOWED"

    # Nonexistent user
    res = await client.post(
        "/api/channels/direct",
        headers=bearer(alice["access_token"]),
        json={"user_id": 999999},
    )
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "USER_NOT_FOUND"


async def test_dm_directory_separation_and_privacy(
    client: AsyncClient, alice, bob
) -> None:
    # Register charlie
    r_charlie = await client.post(
        "/api/auth/register",
        json={"username": "charlie", "password": "Password123!"},
    )
    assert r_charlie.status_code == 201
    charlie = r_charlie.json()

    # Alice creates DM with Bob
    res = await client.post(
        "/api/channels/direct",
        headers=bearer(alice["access_token"]),
        json={"user_id": bob["user"]["id"]},
    )
    dm_id = res.json()["id"]

    # Charlie lists public channels: DM must NOT be visible in public directory
    res_pub = await client.get("/api/channels", headers=bearer(charlie["access_token"]))
    assert res_pub.status_code == 200
    pub_ids = [c["id"] for c in res_pub.json()]
    assert dm_id not in pub_ids

    # Charlie lists direct channels: empty
    res_dms = await client.get("/api/channels/direct", headers=bearer(charlie["access_token"]))
    assert res_dms.status_code == 200
    assert res_dms.json() == []

    # Charlie cannot view Alice & Bob's DM
    res_view = await client.get(f"/api/channels/{dm_id}", headers=bearer(charlie["access_token"]))
    assert res_view.status_code == 404

    # Charlie cannot join Alice & Bob's DM
    res_join = await client.post(f"/api/channels/{dm_id}/join", headers=bearer(charlie["access_token"]))
    assert res_join.status_code == 403

    # Alice lists her DMs
    alice_dms = await client.get("/api/channels/direct", headers=bearer(alice["access_token"]))
    assert len(alice_dms.json()) == 1
    assert alice_dms.json()[0]["id"] == dm_id
    assert alice_dms.json()[0]["name"] == bob["user"]["username"]


async def test_voice_message_in_dm(
    client: AsyncClient, alice, bob, make_audio
) -> None:
    res = await client.post(
        "/api/channels/direct",
        headers=bearer(alice["access_token"]),
        json={"user_id": bob["user"]["id"]},
    )
    dm_id = res.json()["id"]

    # Alice uploads a voice message to the DM channel
    upload = await client.post(
        f"/api/channels/{dm_id}/messages",
        headers=bearer(alice["access_token"]),
        files={"file": ("msg.webm", make_audio("ok1.webm", 1.0), "audio/webm")},
        data={"client_id": str(uuid.uuid4())},
    )
    assert upload.status_code == 202
