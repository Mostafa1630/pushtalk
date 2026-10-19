# PushTalk backend image: used by the `migrate`, `api` and `worker` services.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# ffmpeg/ffprobe: upload validation (real duration) and worker normalization.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first for better layer caching. Dev deps (pytest) are included
# so the test suite can run inside the same image: `docker compose run --rm api pytest`.
COPY requirements.txt requirements-dev.txt ./
RUN pip install -r requirements-dev.txt

# Bake the speech-to-text model into the image (its own layer, so later code
# changes never re-download it). Keep in sync with TRANSCRIPTION_MODEL.
ARG WHISPER_MODEL=base
COPY scripts/warm_transcription.py ./scripts/warm_transcription.py
RUN python scripts/warm_transcription.py "$WHISPER_MODEL" /opt/whisper

COPY . .

# Run as an unprivileged user. The media directory is created here with the
# right owner so the named volume mounted on it inherits that ownership.
RUN useradd --create-home --uid 1000 app \
    && mkdir -p /data/media \
    && chown -R app:app /data/media /app
USER app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
