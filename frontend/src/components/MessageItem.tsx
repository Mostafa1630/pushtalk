import { ownStatusLabel, type ChatMessage } from "../messages/messageModel";
import { API_BASE } from "../api/client";
import { useLanguage, type TranslationKey } from "../i18n";
import { rateLabel } from "../playback/rate";
import { Waveform } from "./Waveform";

const DEFAULT_AVATAR = "/images/avatar-placeholder.jpg";

interface Props {
  message: ChatMessage;
  isOwn: boolean;
  isAdmin: boolean;
  isPlaying: boolean;
  /** The playing message is held where the user paused it. */
  isPaused: boolean;
  isQueued: boolean;
  rate: number;
  onTogglePlay: () => void;
  onCycleRate: () => void;
  onRetry: () => void;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "";
  const s = Math.round(ms / 100) / 10;
  return `${s.toFixed(1)}s`;
}

const ERROR_TRANSLATIONS: Record<string, TranslationKey> = {
  AUDIO_TOO_SHORT: "audioTooShort",
  AUDIO_TOO_LONG: "audioTooLong",
  AUDIO_INVALID: "audioInvalid",
  EMPTY_FILE: "emptyFile",
  FILE_TOO_LARGE: "fileTooLarge",
  UNSUPPORTED_MEDIA_TYPE: "unsupportedMedia",
  UNRECOGNIZED_AUDIO_CONTENT: "unsupportedMedia",
  FFMPEG_FAILED: "serverAudioError",
  AUDIO_ERROR: "serverAudioError",
  PROCESSING_TIMEOUT: "processingTimeout",
  PROCESSING_ERROR: "processingError",
  QUEUE_UNAVAILABLE: "queueUnavailable",
  UPLOAD_MISSING: "uploadMissing",
  STORAGE_ERROR: "storageError",
  FFMPEG_UNAVAILABLE: "serverAudioError",
  NETWORK_ERROR: "networkError",
  UPLOAD_FAILED: "uploadFailed",
};

export function MessageItem({
  message: m,
  isOwn,
  isAdmin,
  isPlaying,
  isPaused,
  isQueued,
  rate,
  onTogglePlay,
  onCycleRate,
  onRetry,
}: Props) {
  const { language, t } = useLanguage();
  // Paused still counts as "this message is the current one" for the icon.
  const playing = isPlaying && !isPaused;
  const classes = [
    "message",
    isOwn ? "message--own" : "",
    isPlaying ? "message--playing" : "",
    `message--${m.status}`,
  ]
    .filter(Boolean)
    .join(" ");
  const senderName = isOwn ? t("senderYou") : m.senderName;
  const avatar = m.senderAvatarUrl
    ? `${API_BASE}${m.senderAvatarUrl.replace(/^\/api/, "")}`
    : DEFAULT_AVATAR;
  const status = ownStatusLabel(m);
  const localizedStatus = status.startsWith("Played ")
    ? t("playedCount", { count: status.slice(7) })
    : status.startsWith("Delivered ")
      ? t("deliveredCount", { count: status.slice(10) })
      : status === "Uploading…"
        ? t("uploading")
        : status === "Not sent"
          ? t("notSent")
          : status === "Processing…"
            ? t("processing")
            : status === "Failed"
              ? t("failed")
              : status === "Played"
                ? t("played")
                : status === "Delivered"
                  ? t("delivered")
                  : t("sent");
  const localizedError = m.errorCode
    ? t(ERROR_TRANSLATIONS[m.errorCode] ?? "processingFailed")
    : m.errorMessage;
  return (
    <li
      className={classes}
      data-testid="message"
      data-status={m.status}
      data-seq={m.seq ?? ""}
    >
      <img
        className="avatar message__avatar"
        src={avatar}
        alt=""
        onError={(event) => {
          event.currentTarget.src = DEFAULT_AVATAR;
        }}
      />
      <div className="message__content">
        <div className="message__meta">
          <span className="message__sender">
            {senderName}
            {isAdmin && <span className="message__admin"> ({t("admin")})</span>}
          </span>
          <span className="message__time">
            {new Date(m.createdAt).toLocaleTimeString(
              language === "ar" ? "ar" : "en",
              { hour: "2-digit", minute: "2-digit" },
            )}
          </span>
          {!isOwn && m.unheard && (
            <span className="badge badge--new">{t("messageNew")}</span>
          )}
          {isQueued && <span className="badge">{t("messageQueued")}</span>}
        </div>
        <div className="message__bubble">
          <div className="message__body">
            <button
              className="icon-button"
              onClick={onTogglePlay}
              disabled={m.status !== "ready"}
              aria-label={playing ? t("pauseMessage") : t("playMessage")}
              title={playing ? t("pauseMessage") : t("playMessage")}
              data-testid="message-play"
            >
              {playing ? "⏸" : "▶"}
            </button>
            <Waveform peaks={m.waveform} active={playing} />
            <span className="message__duration">
              {formatDuration(m.durationMs)}
            </span>
            <button
              className="message__rate"
              onClick={onCycleRate}
              disabled={m.status !== "ready"}
              aria-label={t("playbackSpeedValue", { rate: rateLabel(rate) })}
              title={t("playbackSpeed")}
              data-testid="message-rate"
            >
              {rateLabel(rate)}
            </button>
          </div>
          {m.transcript && (
            <p className="message__transcript" data-testid="message-transcript">
              {m.transcript}
            </p>
          )}
          {isOwn && (
            <div className="message__status" data-testid="message-status">
              {localizedStatus}
              {localizedError && (
                <span className="message__error"> · {localizedError}</span>
              )}
              {m.status === "upload_failed" && (
                <button className="link-button" onClick={onRetry}>
                  {t("retry")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
