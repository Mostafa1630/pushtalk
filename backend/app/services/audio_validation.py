"""Upload validation: size, declared MIME, real container, real duration.

Order matters: the cheap checks (size, MIME, magic bytes) run before the
expensive one (decoding with ffmpeg), so junk is rejected quickly.
"""

from pathlib import Path

from app.audio import ffmpeg
from app.audio.sniff import ALLOWED_DECLARED_MIME, normalize_declared_mime, sniff_audio_container
from app.core.config import Settings
from app.core.errors import PayloadTooLarge, ServiceUnavailable, UnsupportedMedia, ValidationFailed


def check_bytes(data: bytes, declared_content_type: str | None, settings: Settings) -> str:
    """Cheap checks on the raw bytes. Returns the detected MIME type."""
    if not data:
        raise ValidationFailed("The recording is empty", code="EMPTY_FILE")
    if len(data) > settings.max_upload_bytes:
        raise PayloadTooLarge(
            f"Recording exceeds the {settings.max_upload_bytes // (1024 * 1024)} MB limit"
        )
    declared = normalize_declared_mime(declared_content_type)
    if declared not in ALLOWED_DECLARED_MIME:
        raise UnsupportedMedia(f"Unsupported audio type '{declared or 'unknown'}'")
    detected = sniff_audio_container(data[:16])
    if detected is None:
        raise UnsupportedMedia(
            "File content is not a supported audio format", code="UNRECOGNIZED_AUDIO_CONTENT"
        )
    return detected


async def check_duration(path: Path, settings: Settings) -> float:
    """Decode the stored upload and enforce the duration limits."""
    limit = settings.max_audio_seconds + settings.duration_tolerance_seconds
    try:
        # Decode a little past the limit so "too long" is detectable but bounded.
        result = await ffmpeg.probe(path, max_seconds=limit + 0.5, timeout=settings.ffmpeg_timeout_seconds)
    except (ffmpeg.AudioToolMissing, ffmpeg.AudioToolTimeout) as exc:
        raise ServiceUnavailable("Audio analysis is temporarily unavailable", code=exc.code) from exc
    except ffmpeg.AudioError as exc:
        raise ValidationFailed(
            "The recording is corrupted or not valid audio", code="AUDIO_INVALID"
        ) from exc

    duration = result.duration_seconds
    if duration < settings.min_audio_seconds:
        raise ValidationFailed(
            f"Recording is too short ({duration:.2f}s). Minimum is {settings.min_audio_seconds}s",
            code="AUDIO_TOO_SHORT",
            details={"duration_seconds": round(duration, 3)},
        )
    if duration > limit:
        raise ValidationFailed(
            f"Recording is too long. Maximum is {settings.max_audio_seconds:.0f}s",
            code="AUDIO_TOO_LONG",
            details={"duration_seconds": round(duration, 3)},
        )
    return duration
