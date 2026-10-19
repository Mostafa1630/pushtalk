"""Build-time warm-up for the transcription model.

Downloads the model (and the VAD model that `vad_filter` needs) into the image
so the worker never requires network access at runtime. Called by the Dockerfile:

    python scripts/warm_transcription.py <model-name> <cache-dir>
"""

import sys
import wave
from pathlib import Path


def main(model_name: str, cache_dir: str) -> None:
    from faster_whisper import WhisperModel

    root = Path(cache_dir)
    root.mkdir(parents=True, exist_ok=True)
    silence = root / "warmup.wav"
    with wave.open(silence, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\x00\x00" * 16000)  # one second of silence

    model = WhisperModel(model_name, device="cpu", compute_type="int8", download_root=cache_dir)
    model.transcribe(str(silence), vad_filter=True)
    silence.unlink(missing_ok=True)
    print(f"transcription model ready: {model_name} -> {cache_dir}", flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: warm_transcription.py <model-name> <cache-dir>")
    main(sys.argv[1], sys.argv[2])
