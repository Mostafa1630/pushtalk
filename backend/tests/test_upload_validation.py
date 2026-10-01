"""Upload path: nothing the client claims is trusted.

Covers size, declared MIME, real content (magic bytes), decodability, real
duration limits, authorization, idempotent retries and queue failures.
"""

import uuid
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.audio.sniff import sniff_audio_container
from app.core.config import get_settings
from app.models import Message
from tests.conftest import FakeQueue, bearer


async def _upload(
    client: AsyncClient,
    token: str,
    channel_id: int,
    data: bytes,
    mime: str = "audio/webm;codecs=opus",
    client_id: str | None = None,
):  # type: ignore[no-untyped-def]
    return await client.post(
        f"/api/channels/{channel_id}/messages",
        headers=bearer(token),
        files={"file": ("recording.webm", data, mime)},
        data={"client_id": client_id or str(uuid.uuid4())},
    )


async def test_valid_upload_is_accepted_stored_and_queued(
    client: AsyncClient, alice: dict[str, Any], channel: dict[str, Any], queue: FakeQueue, storage, session, make_audio
) -> None:  # type: ignore[no-untyped-def]
    r = await _upload(client, alice["access_token"], channel["id"], make_audio("ok.webm", 2.0))
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["status"] == "processing"
    assert body["seq"] is None  # seq is assigned by the worker, not at upload

    message_id = uuid.UUID(body["id"])
    assert queue.enqueued == [message_id]  # returned immediately, processing is async
    message = await session.get(Message, message_id)
    assert message.upload_mime == "audio/webm"  # detected from content
    assert storage.exists(message.upload_path)


async def test_client_reported_type_does_not_matter_only_content(
    client: AsyncClient, alice, channel, make_audio
) -> None:  # type: ignore[no-untyped-def]
    # A real Ogg file labelled as WebM is accepted; the stored type is the real one.
    r = await _upload(client, alice["access_token"], channel["id"], make_audio("ok.ogg", 1.0, fmt="ogg"), "audio/webm")
    assert r.status_code == 202, r.text


async def test_wav_upload_is_accepted(client: AsyncClient, alice, channel, make_audio) -> None:  # type: ignore[no-untyped-def]
    wav = make_audio("ok.wav", 1.0, fmt="wav", codec="pcm_s16le")
    r = await _upload(client, alice["access_token"], channel["id"], wav, "audio/wav")
    assert r.status_code == 202, r.text


async def test_empty_file_is_rejected(client: AsyncClient, alice, channel, queue: FakeQueue) -> None:  # type: ignore[no-untyped-def]
    r = await _upload(client, alice["access_token"], channel["id"], b"")
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "EMPTY_FILE"
    assert queue.enqueued == []


async def test_disallowed_declared_mime_is_rejected(client: AsyncClient, alice, channel, make_audio) -> None:  # type: ignore[no-untyped-def]
    r = await _upload(client, alice["access_token"], channel["id"], make_audio("ok.webm", 1.0), "application/pdf")
    assert r.status_code == 415
    assert r.json()["error"]["code"] == "UNSUPPORTED_MEDIA_TYPE"


async def test_non_audio_content_with_audio_mime_is_rejected(client: AsyncClient, alice, channel) -> None:  # type: ignore[no-untyped-def]
    r = await _upload(client, alice["access_token"], channel["id"], b"#!/bin/sh\necho pwned\n" * 10, "audio/webm")
    assert r.status_code == 415
    assert r.json()["error"]["code"] == "UNRECOGNIZED_AUDIO_CONTENT"


async def test_corrupted_audio_is_rejected(client: AsyncClient, alice, channel, make_audio, storage) -> None:  # type: ignore[no-untyped-def]
    data = bytearray(make_audio("ok.webm", 2.0))
    for i in range(64, len(data), 5):  # keep the magic bytes, destroy the rest
        data[i] ^= 0xFF
    before = set((storage.root / "uploads").glob("*.bin"))
    r = await _upload(client, alice["access_token"], channel["id"], bytes(data))
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "AUDIO_INVALID"
    assert set((storage.root / "uploads").glob("*.bin")) == before  # rejected upload not kept


async def test_too_short_audio_is_rejected_by_real_duration(client: AsyncClient, alice, channel, make_audio) -> None:  # type: ignore[no-untyped-def]
    r = await _upload(client, alice["access_token"], channel["id"], make_audio("short.webm", 0.3))
    assert r.status_code == 422
    error = r.json()["error"]
    assert error["code"] == "AUDIO_TOO_SHORT"
    assert error["details"]["duration_seconds"] < 0.5


async def test_too_long_audio_is_rejected_by_real_duration(client: AsyncClient, alice, channel, make_audio) -> None:  # type: ignore[no-untyped-def]
    r = await _upload(client, alice["access_token"], channel["id"], make_audio("long.webm", 62))
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "AUDIO_TOO_LONG"


async def test_file_larger_than_limit_is_rejected(client: AsyncClient, alice, channel, make_audio) -> None:  # type: ignore[no-untyped-def]
    small = get_settings().model_copy(update={"max_upload_bytes": 1024})
    client.app.dependency_overrides[get_settings] = lambda: small  # type: ignore[attr-defined]
    r = await _upload(client, alice["access_token"], channel["id"], make_audio("ok.webm", 2.0))
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "FILE_TOO_LARGE"


async def test_missing_client_id_is_a_validation_error(client: AsyncClient, alice, channel, make_audio) -> None:  # type: ignore[no-untyped-def]
    r = await client.post(
        f"/api/channels/{channel['id']}/messages",
        headers=bearer(alice["access_token"]),
        files={"file": ("r.webm", make_audio("ok.webm", 1.0), "audio/webm")},
    )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_upload_requires_authentication(client: AsyncClient, channel, make_audio) -> None:  # type: ignore[no-untyped-def]
    r = await client.post(
        f"/api/channels/{channel['id']}/messages",
        files={"file": ("r.webm", make_audio("ok.webm", 1.0), "audio/webm")},
        data={"client_id": str(uuid.uuid4())},
    )
    assert r.status_code == 401


async def test_non_member_cannot_upload(client: AsyncClient, channel, make_audio) -> None:  # type: ignore[no-untyped-def]
    r = await client.post("/api/auth/register", json={"username": "mallory", "password": "password123"})
    token = r.json()["access_token"]
    r = await _upload(client, token, channel["id"], make_audio("ok.webm", 1.0))
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "NOT_A_MEMBER"


async def test_upload_to_missing_channel_is_404(client: AsyncClient, alice, make_audio) -> None:  # type: ignore[no-untyped-def]
    r = await _upload(client, alice["access_token"], 424242, make_audio("ok.webm", 1.0))
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "CHANNEL_NOT_FOUND"


async def test_retry_with_same_client_id_is_idempotent(
    client: AsyncClient, alice, channel, queue: FakeQueue, session, make_audio
) -> None:  # type: ignore[no-untyped-def]
    cid = str(uuid.uuid4())
    first = await _upload(client, alice["access_token"], channel["id"], make_audio("ok.webm", 1.0), client_id=cid)
    second = await _upload(client, alice["access_token"], channel["id"], make_audio("ok.webm", 1.0), client_id=cid)
    assert first.status_code == 202 and second.status_code == 200
    assert first.json()["id"] == second.json()["id"]
    assert len(queue.enqueued) == 1
    rows = (await session.execute(select(Message).where(Message.client_id == uuid.UUID(cid)))).scalars().all()
    assert len(rows) == 1


async def test_queue_unavailable_marks_message_failed_and_returns_503(
    client: AsyncClient, alice, channel, queue: FakeQueue, session, make_audio
) -> None:  # type: ignore[no-untyped-def]
    queue.fail = True
    r = await _upload(client, alice["access_token"], channel["id"], make_audio("ok.webm", 1.0))
    assert r.status_code == 503
    error = r.json()["error"]
    assert error["code"] == "QUEUE_UNAVAILABLE"
    message = await session.get(Message, uuid.UUID(error["details"]["message_id"]))
    assert message.status == "failed" and message.error_code == "QUEUE_UNAVAILABLE"


async def test_retry_after_queue_outage_requeues_the_same_message(
    client: AsyncClient, alice, channel, queue: FakeQueue, make_audio
) -> None:  # type: ignore[no-untyped-def]
    cid = str(uuid.uuid4())
    audio = make_audio("ok.webm", 1.0)
    queue.fail = True
    first = await _upload(client, alice["access_token"], channel["id"], audio, client_id=cid)
    assert first.status_code == 503
    message_id = first.json()["error"]["details"]["message_id"]

    queue.fail = False  # Redis is back; the client retries with the same client_id
    retry = await _upload(client, alice["access_token"], channel["id"], audio, client_id=cid)
    assert retry.status_code == 202, retry.text
    assert retry.json()["id"] == message_id and retry.json()["status"] == "processing"
    assert queue.enqueued == [uuid.UUID(message_id)]


@pytest.mark.parametrize(
    ("head", "expected"),
    [
        (b"\x1a\x45\xdf\xa3\x01\x00\x00\x00", "audio/webm"),
        (b"OggS\x00\x02\x00\x00", "audio/ogg"),
        (b"RIFF\x24\x08\x00\x00WAVEfmt ", "audio/wav"),
        (b"\x00\x00\x00\x1cftypM4A ", "audio/mp4"),
        (b"ID3\x04\x00\x00\x00\x00", "audio/mpeg"),
        (b"%PDF-1.7\n", None),
        (b"<html>", None),
        (b"", None),
    ],
)
def test_magic_byte_sniffing(head: bytes, expected: str | None) -> None:
    assert sniff_audio_container(head) == expected
