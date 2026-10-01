"""Content-based container detection ("magic bytes").

The browser-supplied Content-Type is only a hint. We look at the first bytes
of the file to decide what it really is, and then ffprobe must agree that it
contains a decodable audio stream.
"""

# MIME types a browser may legitimately send for a MediaRecorder recording.
ALLOWED_DECLARED_MIME = frozenset(
    {
        "audio/webm",
        "video/webm",  # some browsers label audio-only WebM this way
        "audio/ogg",
        "audio/mp4",
        "audio/x-m4a",
        "audio/mpeg",
        "audio/wav",
        "audio/x-wav",
        "audio/wave",
    }
)


def sniff_audio_container(head: bytes) -> str | None:
    """Return the canonical MIME type for the container, or None if unknown."""
    if head.startswith(b"\x1a\x45\xdf\xa3"):  # EBML header (WebM / Matroska)
        return "audio/webm"
    if head.startswith(b"OggS"):
        return "audio/ogg"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio/wav"
    if head[4:8] == b"ftyp":  # ISO BMFF (MP4 / M4A, Safari's MediaRecorder)
        return "audio/mp4"
    if head.startswith(b"ID3") or (len(head) > 1 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0):
        return "audio/mpeg"
    return None


def normalize_declared_mime(content_type: str | None) -> str:
    """'audio/webm;codecs=opus' -> 'audio/webm'."""
    return (content_type or "").split(";", 1)[0].strip().lower()
