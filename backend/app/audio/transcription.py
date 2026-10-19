"""Speech-to-text for voice messages (faster-whisper on CPU).

The model is loaded once per worker process and shared by every job. Inference
is blocking, so it runs in a worker thread behind a semaphore that lets only
one job through at a time: messages are short, and several parallel CPU decodes
would each be slower than the sum of sequential ones.

Nothing here may fail a message. By the time transcription runs the audio is
already `ready` and delivered, so the worst case is a message with no transcript.
"""

import asyncio
import logging
import threading
from pathlib import Path

from app.core.config import Settings

logger = logging.getLogger("app.audio")

_model = None
_model_lock = threading.Lock()
_inference = asyncio.Semaphore(1)


class TranscriptionError(Exception):
    """The audio could not be turned into text."""


def _load_model(settings: Settings):
    global _model
    with _model_lock:
        if _model is None:
            from faster_whisper import WhisperModel

            logger.info(
                "transcription_model_loading",
                extra={"model": settings.transcription_model},
            )
            _model = WhisperModel(
                settings.transcription_model,
                device="cpu",
                compute_type="int8",
                download_root=settings.transcription_model_dir,
            )
            logger.info("transcription_model_loaded", extra={"model": settings.transcription_model})
        return _model


def _decode(path: Path, settings: Settings) -> tuple[str, str]:
    model = _load_model(settings)
    segments, info = model.transcribe(
        str(path),
        vad_filter=True,
        # Whisper tends to loop on short clips when it conditions on its own text.
        condition_on_previous_text=False,
    )
    parts = [part for segment in segments if (part := segment.text.strip())]
    text = " ".join(parts)[: settings.transcription_max_chars].strip()
    return text, info.language


async def transcribe(settings: Settings, path: Path, *, timeout: float) -> str | None:
    """Return the transcript of `path`, or None when there was no speech.

    Raises TranscriptionError if decoding or the model itself failed.
    """
    async with _inference:
        try:
            text, language = await asyncio.wait_for(
                asyncio.to_thread(_decode, path, settings), timeout
            )
        except TimeoutError as exc:
            raise TranscriptionError(f"took longer than {timeout}s") from exc
        except Exception as exc:  # noqa: BLE001 - reported, never propagated to the message
            raise TranscriptionError(f"{type(exc).__name__}: {exc}") from exc

    logger.info("transcription_decoded", extra={"language": language, "chars": len(text)})
    return text or None
