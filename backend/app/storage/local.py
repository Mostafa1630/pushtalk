"""Media storage on a local (Docker) volume shared by the API and the worker.

Only relative keys (e.g. "uploads/<uuid>.bin") are stored in the database, so
the storage backend can be swapped (e.g. for MinIO/S3) behind this interface
without a data migration.
"""

import os
import uuid
from pathlib import Path


class StorageError(Exception):
    """Raised when the media volume cannot be read or written."""


class LocalStorage:
    def __init__(self, root: str) -> None:
        self.root = Path(root).resolve()

    def path_for(self, key: str) -> Path:
        path = (self.root / key).resolve()
        # Keys are always generated server-side, but guard against traversal anyway.
        if self.root not in path.parents:
            raise StorageError("Invalid storage key")
        return path

    @staticmethod
    def upload_key(message_id: uuid.UUID) -> str:
        return f"uploads/{message_id}.bin"

    @staticmethod
    def audio_key(message_id: uuid.UUID) -> str:
        return f"audio/{message_id}.ogg"

    @staticmethod
    def avatar_key(user_id: int, ext: str) -> str:
        # Unique per upload: the token becomes the avatar URL's cache buster.
        return f"avatars/{user_id}-{uuid.uuid4().hex[:10]}.{ext}"

    @staticmethod
    def channel_image_key(channel_id: int, ext: str) -> str:
        return f"channels/{channel_id}.{ext}"

    def write_bytes(self, key: str, data: bytes) -> None:
        path = self.path_for(key)
        tmp = path.with_suffix(path.suffix + ".part")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_bytes(data)
            # Atomic rename: readers never observe a half-written file.
            os.replace(tmp, path)
        except OSError as exc:
            tmp.unlink(missing_ok=True)
            raise StorageError(f"Could not write {key}: {exc.strerror}") from exc

    def exists(self, key: str) -> bool:
        return self.path_for(key).is_file()

    def delete(self, key: str) -> None:
        try:
            self.path_for(key).unlink(missing_ok=True)
        except OSError as exc:
            raise StorageError(f"Could not delete {key}: {exc.strerror}") from exc
