"""Thin async wrappers around the ffmpeg/ffprobe CLIs.

Everything that touches audio content goes through here, so tests can mock a
single module. All subprocesses run with a hard timeout and are killed on
expiry, so a malicious or broken file can never hang the API or the worker.
"""

import asyncio
import json
import logging
import shutil
from array import array
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger("app.audio")


class AudioError(Exception):
    """Base class. `code` is a stable, client-safe identifier."""

    code = "AUDIO_ERROR"


class AudioInvalid(AudioError):
    """The file is not decodable audio (corrupted, wrong format, no audio stream)."""

    code = "AUDIO_INVALID"


class AudioToolTimeout(AudioError):
    code = "PROCESSING_TIMEOUT"


class AudioToolMissing(AudioError):
    code = "FFMPEG_UNAVAILABLE"


class AudioToolFailed(AudioError):
    code = "FFMPEG_FAILED"


@dataclass(frozen=True)
class ProbeResult:
    duration_seconds: float
    format_name: str
    codec_name: str


async def _run(args: list[str], timeout: float) -> tuple[int, bytes, bytes]:
    if shutil.which(args[0]) is None:
        raise AudioToolMissing(f"{args[0]} is not installed")
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError as exc:
        proc.kill()
        await proc.wait()
        raise AudioToolTimeout(f"{args[0]} timed out after {timeout}s") from exc
    return proc.returncode or 0, stdout, stderr


def _tail(stderr: bytes, limit: int = 300) -> str:
    return stderr.decode("utf-8", "replace").strip()[-limit:]


async def probe(path: Path, *, max_seconds: float, timeout: float) -> ProbeResult:
    """Return the REAL duration of the first audio stream by decoding it.

    Container metadata is not trusted (MediaRecorder WebM files often have no
    duration at all, and a crafted file can claim anything), so we decode the
    stream to a null sink and read how far the decoder got. Decoding stops at
    `max_seconds`, which bounds the work for maliciously long files.
    """
    rc, out, err = await _run(
        [
            "ffprobe", "-v", "error", "-select_streams", "a:0",
            "-show_entries", "stream=codec_name,codec_type:format=format_name",
            "-of", "json", str(path),
        ],
        timeout,
    )
    if rc != 0:
        raise AudioInvalid(f"ffprobe rejected file: {_tail(err)}")
    try:
        info = json.loads(out or b"{}")
    except json.JSONDecodeError as exc:
        raise AudioInvalid("ffprobe returned unreadable output") from exc
    streams = info.get("streams") or []
    if not streams or streams[0].get("codec_type") != "audio":
        raise AudioInvalid("File contains no audio stream")

    rc, out, err = await _run(
        [
            "ffmpeg", "-nostdin", "-v", "error", "-xerror", "-i", str(path),
            "-map", "0:a:0", "-t", f"{max_seconds:.3f}",
            "-f", "null", "-progress", "pipe:1", "-nostats", "-",
        ],
        timeout,
    )
    if rc != 0:
        raise AudioInvalid(f"Audio could not be decoded: {_tail(err)}")
    duration_us = 0
    for line in out.decode("ascii", "replace").splitlines():
        if line.startswith("out_time_us="):
            value = line.split("=", 1)[1].strip()
            if value.lstrip("-").isdigit():
                duration_us = max(duration_us, int(value))
    return ProbeResult(
        duration_seconds=duration_us / 1_000_000,
        format_name=str(info.get("format", {}).get("format_name", "")),
        codec_name=str(streams[0].get("codec_name", "")),
    )


async def normalize_to_opus(src: Path, dst: Path, *, max_seconds: float, timeout: float) -> None:
    """Transcode to mono 48 kHz Opus in an Ogg container with loudness normalization.

    `-t max_seconds` enforces the hard length cap on the output regardless of
    the small tolerance accepted at upload time.
    """
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".tmp.ogg")
    rc, _, err = await _run(
        [
            "ffmpeg", "-nostdin", "-y", "-v", "error", "-i", str(src),
            "-map", "0:a:0", "-vn", "-t", f"{max_seconds:.3f}",
            "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
            "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k",
            "-f", "ogg", str(tmp),
        ],
        timeout,
    )
    if rc != 0:
        tmp.unlink(missing_ok=True)
        raise AudioToolFailed(f"ffmpeg normalization failed: {_tail(err)}")
    tmp.replace(dst)


async def waveform_peaks(path: Path, *, buckets: int, timeout: float) -> list[float]:
    """Decode to 8 kHz mono PCM and return `buckets` peak values in [0, 1].

    Peaks are scaled relative to the loudest bucket so quiet recordings still
    render a visible shape in the UI.
    """
    rc, out, err = await _run(
        [
            "ffmpeg", "-nostdin", "-v", "error", "-i", str(path),
            "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1",
        ],
        timeout,
    )
    if rc != 0:
        raise AudioToolFailed(f"ffmpeg waveform extraction failed: {_tail(err)}")
    return compute_peaks(out, buckets)


def compute_peaks(pcm_s16le: bytes, buckets: int) -> list[float]:
    samples = array("h")
    samples.frombytes(pcm_s16le[: len(pcm_s16le) - (len(pcm_s16le) % 2)])
    if not samples or buckets <= 0:
        return [0.0] * max(buckets, 0)
    size = max(1, len(samples) // buckets)
    peaks: list[int] = []
    for i in range(buckets):
        chunk = samples[i * size : (i + 1) * size] if i < buckets - 1 else samples[i * size :]
        peaks.append(max((abs(s) for s in chunk), default=0))
    loudest = max(peaks) or 1
    return [round(p / loudest, 3) for p in peaks]
