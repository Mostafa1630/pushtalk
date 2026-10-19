"""The processing job: success, failure handling, idempotency, ordering, retries.

ffmpeg runs for real on generated audio; failure modes that are hard to
produce for real (timeouts, crashes mid-job) are mocked.
"""

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from arq import Retry
from httpx import AsyncClient
from sqlalchemy import update

from app.audio import ffmpeg
from app.db.session import SessionLocal
from app.models import Message
from app.worker import tasks
from tests.conftest import FakeRedis, bearer


@pytest.fixture
def ctx(settings, storage, fake_redis: FakeRedis) -> dict[str, Any]:  # type: ignore[no-untyped-def]
    return {
        "settings": settings,
        "session_factory": SessionLocal,
        "storage": storage,
        "redis": fake_redis,
        "job_try": 1,
    }


async def _upload(client: AsyncClient, token: str, channel_id: int, data: bytes) -> uuid.UUID:
    r = await client.post(
        f"/api/channels/{channel_id}/messages",
        headers=bearer(token),
        files={"file": ("r.webm", data, "audio/webm")},
        data={"client_id": str(uuid.uuid4())},
    )
    assert r.status_code == 202, r.text
    return uuid.UUID(r.json()["id"])


async def _reload(mid: uuid.UUID) -> Message:
    async with SessionLocal() as s:
        return await s.get(Message, mid)


def _events(fake_redis: FakeRedis) -> list[dict[str, Any]]:
    # Only channel broadcasts (user-topic notification publishes are covered in test_notifications).
    return [
        json.loads(data)
        for topic, data in fake_redis.published
        if topic.startswith("pushtalk:channel:")
    ]


async def test_success_normalizes_extracts_metadata_and_broadcasts(
    client, alice, channel, ctx, storage, fake_redis, make_audio
) -> None:  # type: ignore[no-untyped-def]
    mid = await _upload(client, alice["access_token"], channel["id"], make_audio("ok2.webm", 2.0))

    assert await tasks.process_message(ctx, str(mid)) == "ready"

    m = await _reload(mid)
    assert m.status == "ready" and m.seq == 1
    assert abs(m.duration_ms - 2000) < 100  # measured, not client reported
    assert len(m.waveform) == ctx["settings"].waveform_peaks and max(m.waveform) == 1.0
    audio = storage.path_for(m.audio_path)
    assert audio.read_bytes()[:4] == b"OggS"  # normalized to Opus/OGG
    assert not storage.exists(m.upload_path)  # raw upload cleaned up

    [event] = _events(fake_redis)
    assert event["type"] == "message.new"
    assert event["message"]["id"] == str(mid) and event["message"]["seq"] == 1
    channel_topics = [t for t, _ in fake_redis.published if t.startswith("pushtalk:channel:")]
    assert channel_topics == [f"pushtalk:channel:{channel['id']}"]


async def test_nothing_is_broadcast_before_processing_succeeds(
    client, alice, channel, fake_redis, make_audio
) -> None:  # type: ignore[no-untyped-def]
    await _upload(client, alice["access_token"], channel["id"], make_audio("ok1.webm", 1.0))
    assert _events(fake_redis) == []  # upload alone never reaches other members


async def test_undecodable_audio_marks_failed_and_notifies_sender(
    client, alice, channel, ctx, storage, fake_redis, make_audio
) -> None:  # type: ignore[no-untyped-def]
    mid = await _upload(client, alice["access_token"], channel["id"], make_audio("ok1.webm", 1.0))
    m = await _reload(mid)
    storage.write_bytes(m.upload_path, b"\x1a\x45\xdf\xa3" + b"\x00garbage" * 200)  # corrupted after upload

    assert await tasks.process_message(ctx, str(mid)) == "failed"

    m = await _reload(mid)
    assert m.status == "failed" and m.seq is None
    assert m.error_code == "FFMPEG_FAILED"
    assert not storage.exists(m.upload_path)
    [event] = _events(fake_redis)
    assert event == {
        "type": "message.failed",
        "message_id": str(mid),
        "client_id": str(m.client_id),
        "sender_id": alice["user"]["id"],
        "error_code": "FFMPEG_FAILED",
    }


async def test_ffmpeg_timeout_marks_failed(
    client, alice, channel, ctx, fake_redis, make_audio, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    mid = await _upload(client, alice["access_token"], channel["id"], make_audio("ok1.webm", 1.0))

    async def hang(*_: Any, **__: Any) -> None:
        raise ffmpeg.AudioToolTimeout("ffmpeg timed out after 30s")

    monkeypatch.setattr(ffmpeg, "normalize_to_opus", hang)
    assert await tasks.process_message(ctx, str(mid)) == "failed"
    assert (await _reload(mid)).error_code == "PROCESSING_TIMEOUT"
    assert _events(fake_redis)[0]["type"] == "message.failed"


async def test_missing_upload_file_marks_failed(client, alice, channel, ctx, storage, make_audio) -> None:  # type: ignore[no-untyped-def]
    mid = await _upload(client, alice["access_token"], channel["id"], make_audio("ok1.webm", 1.0))
    storage.delete((await _reload(mid)).upload_path)  # e.g. volume not shared / wiped
    assert await tasks.process_message(ctx, str(mid)) == "failed"
    assert (await _reload(mid)).error_code == "UPLOAD_MISSING"


async def test_duplicate_job_run_is_a_noop(client, alice, channel, ctx, fake_redis, make_audio) -> None:  # type: ignore[no-untyped-def]
    mid = await _upload(client, alice["access_token"], channel["id"], make_audio("ok1.webm", 1.0))
    assert await tasks.process_message(ctx, str(mid)) == "ready"
    assert await tasks.process_message(ctx, str(mid)) == "skipped"  # e.g. arq re-ran after a crash
    assert (await _reload(mid)).seq == 1
    assert len(_events(fake_redis)) == 1  # broadcast exactly once


async def test_broadcast_order_follows_upload_order_even_if_older_job_is_slower(
    client, alice, channel, ctx, fake_redis, make_audio, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    older = await _upload(client, alice["access_token"], channel["id"], make_audio("ok2.webm", 2.0))
    newer = await _upload(client, alice["access_token"], channel["id"], make_audio("ok1.webm", 1.0))

    real_normalize = ffmpeg.normalize_to_opus

    async def slow_for_older(src, dst, **kw):  # type: ignore[no-untyped-def]
        if str(older) in str(src):
            await asyncio.sleep(1.0)  # older message takes longer to process
        await real_normalize(src, dst, **kw)

    monkeypatch.setattr(ffmpeg, "normalize_to_opus", slow_for_older)
    # Start the NEWER job first; it must wait for the older one.
    await asyncio.gather(tasks.process_message(ctx, str(newer)), tasks.process_message(ctx, str(older)))

    assert (await _reload(older)).seq == 1
    assert (await _reload(newer)).seq == 2
    assert [e["message"]["id"] for e in _events(fake_redis)] == [str(older), str(newer)]


async def test_ordering_wait_is_bounded(client, alice, channel, ctx, make_audio) -> None:  # type: ignore[no-untyped-def]
    # An older message that never finishes must not block the channel forever.
    await _upload(client, alice["access_token"], channel["id"], make_audio("ok1.webm", 1.0))  # never processed
    newer = await _upload(client, alice["access_token"], channel["id"], make_audio("ok2.webm", 2.0))
    ctx["settings"] = ctx["settings"].model_copy(update={"ordering_wait_seconds": 0.5})
    assert await tasks.process_message(ctx, str(newer)) == "ready"
    assert (await _reload(newer)).seq == 1


async def test_transient_error_is_retried_then_marked_failed(
    client, alice, channel, ctx, make_audio, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    mid = await _upload(client, alice["access_token"], channel["id"], make_audio("ok1.webm", 1.0))

    async def db_down(*_: Any, **__: Any) -> None:
        raise ConnectionError("database unreachable")

    monkeypatch.setattr(tasks, "_wait_for_older_messages", db_down)
    with pytest.raises(Retry):
        await tasks.process_message(ctx, str(mid))
    assert (await _reload(mid)).status == "processing"  # still retryable

    ctx["job_try"] = tasks.MAX_TRIES
    assert await tasks.process_message(ctx, str(mid)) == "failed"
    assert (await _reload(mid)).error_code == "PROCESSING_ERROR"


async def test_stale_sweeper_fails_stuck_messages(client, alice, channel, ctx, fake_redis, make_audio) -> None:  # type: ignore[no-untyped-def]
    mid = await _upload(client, alice["access_token"], channel["id"], make_audio("ok1.webm", 1.0))
    async with SessionLocal() as s, s.begin():
        await s.execute(
            update(Message).where(Message.id == mid).values(created_at=datetime.now(UTC) - timedelta(hours=1))
        )
    assert await tasks.sweep_stale_messages(ctx) == 1
    m = await _reload(mid)
    assert m.status == "failed" and m.error_code == "PROCESSING_TIMEOUT"
    assert _events(fake_redis)[0]["type"] == "message.failed"
    # A late job for the swept message does nothing.
    assert await tasks.process_message(ctx, str(mid)) == "skipped"


def test_compute_peaks_normalizes_to_loudest_bucket() -> None:
    import struct

    pcm = struct.pack("<8h", 0, 100, -200, 50, 1000, -1000, 10, 0)
    assert ffmpeg.compute_peaks(pcm, 4) == [0.1, 0.2, 1.0, 0.01]
    assert ffmpeg.compute_peaks(b"", 3) == [0.0, 0.0, 0.0]


async def test_transcribe_message_success(
    client, alice, channel, ctx, fake_redis, make_audio, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    mid = await _upload(client, alice["access_token"], channel["id"], make_audio("ok1.webm", 1.0))
    assert await tasks.process_message(ctx, str(mid)) == "ready"

    from app.audio import transcription

    async def fake_transcribe(*args: Any, **kwargs: Any) -> str:
        return "Hello PushTalk voice message"

    monkeypatch.setattr(transcription, "transcribe", fake_transcribe)
    assert await tasks.transcribe_message(ctx, str(mid)) == "transcribed"

    m = await _reload(mid)
    assert m.transcript == "Hello PushTalk voice message"
    transcripts = [e for e in _events(fake_redis) if e.get("type") == "message.transcript"]
    assert len(transcripts) == 1
    assert transcripts[0]["message_id"] == str(mid)
    assert transcripts[0]["transcript"] == "Hello PushTalk voice message"


async def test_transcribe_message_failure_leaves_message_ready(
    client, alice, channel, ctx, fake_redis, make_audio, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    mid = await _upload(client, alice["access_token"], channel["id"], make_audio("ok1.webm", 1.0))
    assert await tasks.process_message(ctx, str(mid)) == "ready"

    from app.audio import transcription

    async def fail_transcribe(*args: Any, **kwargs: Any) -> str:
        raise transcription.TranscriptionError("model error")

    monkeypatch.setattr(transcription, "transcribe", fail_transcribe)
    assert await tasks.transcribe_message(ctx, str(mid)) == "failed"

    m = await _reload(mid)
    # The message is still ready and playable, only transcript is None
    assert m.status == "ready"
    assert m.transcript is None

