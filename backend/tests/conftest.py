"""Shared test fixtures.

Tests run against a REAL PostgreSQL database (TEST_DATABASE_URL) because the
code relies on Postgres features (row locks, ON CONFLICT, JSONB). Redis and
the job queue are replaced with in-memory fakes; ffmpeg is real (it is in
the backend image) unless a test mocks it on purpose.
"""

import os
import shutil
import subprocess
import tempfile
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

# Configure the environment BEFORE importing the app (settings are read at import).
_MEDIA = tempfile.mkdtemp(prefix="pushtalk-test-media-")
os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://pushtalk:pushtalk_dev_password@localhost:5432/pushtalk_test",
)
os.environ["JWT_SECRET"] = "test-secret-that-is-long-enough-for-hs256-0123"
os.environ["MEDIA_ROOT"] = _MEDIA
os.environ["LOG_LEVEL"] = "WARNING"

import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.api.deps import get_job_queue  # noqa: E402
from app.core.config import get_settings  # noqa: E402
from app.db.session import SessionLocal, engine  # noqa: E402
from app.main import create_app  # noqa: E402
from app.storage.local import LocalStorage  # noqa: E402

BACKEND_DIR = Path(__file__).resolve().parents[1]
requires_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------
class FakeQueue:
    def __init__(self) -> None:
        self.enqueued: list[uuid.UUID] = []
        self.fail = False

    async def enqueue_processing(self, message_id: uuid.UUID) -> None:
        if self.fail:
            raise ConnectionError("redis down")
        self.enqueued.append(message_id)


class FakeRedis:
    """Records publishes; enough for code paths that only publish/ping."""

    def __init__(self) -> None:
        self.published: list[tuple[str, str]] = []

    async def publish(self, channel: str, data: str) -> int:
        self.published.append((channel, data))
        return 1

    async def ping(self) -> bool:
        return True


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session", autouse=True)
def migrated_database() -> None:
    """Build the schema through the real Alembic migrations (tests them too)."""
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    cfg.set_main_option("sqlalchemy.url", os.environ["DATABASE_URL"])
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")


@pytest.fixture(autouse=True)
async def clean_tables() -> AsyncIterator[None]:
    yield
    async with engine.begin() as conn:
        await conn.execute(
            text("TRUNCATE message_receipts, messages, channel_members, channels, users RESTART IDENTITY CASCADE")
        )


@pytest.fixture
async def session() -> AsyncIterator[Any]:
    async with SessionLocal() as s:
        yield s


# ---------------------------------------------------------------------------
# App / HTTP client
# ---------------------------------------------------------------------------
@pytest.fixture
def storage() -> LocalStorage:
    return LocalStorage(_MEDIA)


@pytest.fixture
def queue() -> FakeQueue:
    return FakeQueue()


@pytest.fixture
def fake_redis() -> FakeRedis:
    return FakeRedis()


@pytest.fixture
async def client(queue: FakeQueue, storage: LocalStorage, fake_redis: FakeRedis) -> AsyncIterator[AsyncClient]:
    app = create_app()
    # The lifespan (real Redis, arq pool, pub/sub hub) is not started in tests.
    app.state.storage = storage
    app.state.redis = fake_redis
    app.dependency_overrides[get_job_queue] = lambda: queue
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        c.app = app  # type: ignore[attr-defined]
        yield c


async def register(client: AsyncClient, username: str, password: str = "password123") -> dict[str, Any]:
    r = await client.post("/api/auth/register", json={"username": username, "password": password})
    assert r.status_code == 201, r.text
    return r.json()


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
async def alice(client: AsyncClient) -> dict[str, Any]:
    return await register(client, "alice")


@pytest.fixture
async def bob(client: AsyncClient) -> dict[str, Any]:
    return await register(client, "bob")


@pytest.fixture
async def channel(client: AsyncClient, alice: dict[str, Any], bob: dict[str, Any]) -> dict[str, Any]:
    """A channel created by alice that bob has joined."""
    r = await client.post("/api/channels", json={"name": "general"}, headers=bearer(alice["access_token"]))
    assert r.status_code == 201, r.text
    ch = r.json()
    r = await client.post(f"/api/channels/{ch['id']}/join", headers=bearer(bob["access_token"]))
    assert r.status_code == 200, r.text
    return ch


# ---------------------------------------------------------------------------
# Audio samples (generated once with ffmpeg)
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def audio_dir() -> Path:
    return Path(tempfile.mkdtemp(prefix="pushtalk-test-audio-"))


def _make(audio_dir: Path, name: str, seconds: float, fmt: str = "webm", codec: str = "libopus") -> bytes:
    out = audio_dir / name
    if not out.exists():
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
             "-c:a", codec, "-b:a", "24k", "-f", fmt, str(out)],
            check=True,
        )
    return out.read_bytes()


@pytest.fixture(scope="session")
def make_audio(audio_dir: Path):  # type: ignore[no-untyped-def]
    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg not installed")
    return lambda name, seconds, fmt="webm", codec="libopus": _make(audio_dir, name, seconds, fmt, codec)


@pytest.fixture
def settings():  # type: ignore[no-untyped-def]
    return get_settings()
