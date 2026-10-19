"""Application configuration.

Every setting comes from environment variables (or a local `.env` file during
development). Nothing secret has a usable default: `JWT_SECRET` must be set,
otherwise the app refuses to start.
"""

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- General -----------------------------------------------------------
    app_env: str = Field(default="development", alias="APP_ENV")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    # Comma-separated list of allowed browser origins for CORS.
    cors_origins: str = Field(default="http://localhost:8080", alias="CORS_ORIGINS")

    # --- Infrastructure ----------------------------------------------------
    database_url: str = Field(alias="DATABASE_URL")
    redis_url: str = Field(default="redis://localhost:6379/0", alias="REDIS_URL")
    media_root: str = Field(default="/data/media", alias="MEDIA_ROOT")

    # --- Auth --------------------------------------------------------------
    jwt_secret: str = Field(alias="JWT_SECRET")
    jwt_algorithm: str = Field(default="HS256", alias="JWT_ALGORITHM")
    access_token_expire_minutes: int = Field(default=720, alias="ACCESS_TOKEN_EXPIRE_MINUTES")

    # --- Audio rules -------------------------------------------------------
    max_upload_bytes: int = Field(default=5 * 1024 * 1024, alias="MAX_UPLOAD_BYTES")
    min_audio_seconds: float = Field(default=0.5, alias="MIN_AUDIO_SECONDS")
    max_audio_seconds: float = Field(default=60.0, alias="MAX_AUDIO_SECONDS")
    # Container timestamps from MediaRecorder can overshoot a hard 60.000 s
    # stop by a few ms; we accept a small tolerance and the worker trims the
    # normalized output to exactly max_audio_seconds.
    duration_tolerance_seconds: float = Field(default=0.5, alias="DURATION_TOLERANCE_SECONDS")
    waveform_peaks: int = Field(default=64, alias="WAVEFORM_PEAKS")

    # --- Processing --------------------------------------------------------
    ffmpeg_timeout_seconds: float = Field(default=30.0, alias="FFMPEG_TIMEOUT_SECONDS")
    # Worker waits at most this long for older in-flight messages of the same
    # channel before publishing (keeps upload order == broadcast order).
    ordering_wait_seconds: float = Field(default=20.0, alias="ORDERING_WAIT_SECONDS")
    # Messages stuck in `processing` longer than this are marked failed.
    processing_stale_seconds: int = Field(default=120, alias="PROCESSING_STALE_SECONDS")
    worker_max_jobs: int = Field(default=4, alias="WORKER_MAX_JOBS")

    # --- Realtime ----------------------------------------------------------
    ws_auth_timeout_seconds: float = Field(default=5.0, alias="WS_AUTH_TIMEOUT_SECONDS")
    presence_ttl_seconds: int = Field(default=45, alias="PRESENCE_TTL_SECONDS")

    # --- Transcription -----------------------------------------------------
    # Second worker step, run only after the message is already `ready`: a slow
    # or failing transcription can never delay or break delivery.
    transcription_enabled: bool = Field(default=True, alias="TRANSCRIPTION_ENABLED")
    # Must match the model baked into the image (see Dockerfile), otherwise the
    # worker downloads it on first use and needs network access.
    transcription_model: str = Field(default="base", alias="TRANSCRIPTION_MODEL")
    transcription_model_dir: str = Field(default="/opt/whisper", alias="TRANSCRIPTION_MODEL_DIR")
    transcription_timeout_seconds: float = Field(default=120.0, alias="TRANSCRIPTION_TIMEOUT_SECONDS")
    # Whisper can repeat itself on a short clip; messages are capped at 60 s.
    transcription_max_chars: int = Field(default=1000, alias="TRANSCRIPTION_MAX_CHARS")

    # --- Rate limiting -----------------------------------------------------
    rate_limit_enabled: bool = Field(default=True, alias="RATE_LIMIT_ENABLED")
    # Sliding-ish fixed window per user (per IP before authentication).
    rate_limit_requests: int = Field(default=120, alias="RATE_LIMIT_REQUESTS")
    rate_limit_window_seconds: int = Field(default=60, alias="RATE_LIMIT_WINDOW_SECONDS")
    # Voice uploads are far more expensive than reads, so they get their own
    # smaller budget on the same window.
    upload_limit_requests: int = Field(default=20, alias="UPLOAD_LIMIT_REQUESTS")
    upload_limit_window_seconds: int = Field(default=60, alias="UPLOAD_LIMIT_WINDOW_SECONDS")

    @field_validator("jwt_secret")
    @classmethod
    def _secret_strength(cls, value: str) -> str:
        if len(value) < 32:
            raise ValueError("JWT_SECRET must be at least 32 characters long")
        return value

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # values come from the environment
