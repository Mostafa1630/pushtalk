"""Image upload sniffing for avatars and channel photos."""

from pathlib import PurePosixPath

ALLOWED_IMAGE_MIME = frozenset({"image/jpeg", "image/png", "image/webp"})
MAX_IMAGE_BYTES = 2 * 1024 * 1024


def sniff_image(head: bytes) -> str | None:
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    return None


def extension_for(mime: str) -> str:
    return {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}[mime]


def avatar_url_for(user_id: int, avatar_path: str | None) -> str | None:
    """Avatar URL carrying the upload token, so a new photo is never served from
    the browser cache. Keys written before tokens existed have none to add."""
    if not avatar_path:
        return None
    url = f"/api/users/{user_id}/avatar"
    token = PurePosixPath(avatar_path).stem.partition("-")[2]
    return f"{url}?v={token}" if token else url
