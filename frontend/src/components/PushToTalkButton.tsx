import { useEffect } from "react";
import { MAX_RECORDING_MS, type RecorderState } from "../recording/useRecorder";
import { useLanguage } from "../i18n";

interface Props {
  state: RecorderState;
  elapsedMs: number;
  disabled: boolean;
  onPress: () => void;
  onRelease: () => void;
}

/** Hold to record, release to send. Works with mouse, touch, pen and the Space key. */
export function PushToTalkButton({
  state,
  elapsedMs,
  disabled,
  onPress,
  onRelease,
}: Props) {
  const { t } = useLanguage();
  const active = state !== "idle";

  // Space bar push-to-talk (ignored while typing in inputs).
  useEffect(() => {
    if (disabled) return;
    const isTyping = (e: KeyboardEvent) =>
      (e.target as HTMLElement | null)?.closest("input, textarea") != null;
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !isTyping(e)) {
        e.preventDefault();
        onPress();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTyping(e)) {
        e.preventDefault();
        onRelease();
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [disabled, onPress, onRelease]);

  const remaining = Math.max(0, (MAX_RECORDING_MS - elapsedMs) / 1000);
  const progress = Math.min(1, elapsedMs / MAX_RECORDING_MS);

  return (
    <div className="ptt">
      <button
        type="button"
        className={`ptt__button${active ? " ptt__button--active" : ""}`}
        disabled={disabled}
        data-testid="ptt"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId); // keep receiving pointerup even if the finger slides off
          onPress();
        }}
        onPointerUp={onRelease}
        onPointerCancel={onRelease}
        onContextMenu={(e) => e.preventDefault()}
        style={{ ["--progress" as string]: String(progress) }}
      >
        <img className="ptt__icon" src="/images/logo.jpg" alt="" />
        <span>
          {state === "recording"
            ? t("releaseToSend")
            : state === "starting"
              ? t("startingMic")
              : t("startRecording")}
        </span>
      </button>
      <div className="ptt__hint">
        {state === "recording"
          ? `${(elapsedMs / 1000).toFixed(1)}s · ${remaining.toFixed(0)}s`
          : t("spaceHint")}
      </div>
    </div>
  );
}
