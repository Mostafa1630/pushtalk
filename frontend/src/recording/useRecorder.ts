// Push-to-talk recording with MediaRecorder.
//
// - The microphone stream is requested on the first press and kept open while
//   the channel page is mounted, so later presses start instantly (no clipped
//   first syllable). It is released on unmount.
// - Recordings shorter than MIN_MS are discarded client-side (the server
//   enforces the same rule on the real decoded duration).
// - Recording auto-stops at MAX_MS and is sent.

import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage, type TranslationKey } from "../i18n";

export const MIN_RECORDING_MS = 500;
export const MAX_RECORDING_MS = 60_000;

export type RecorderState = "idle" | "starting" | "recording";

export interface Recording {
  blob: Blob;
  mimeType: string;
  durationMs: number; // informational only; the server measures the real duration
}

interface Options {
  onRecorded: (rec: Recording) => void;
  onTooShort: () => void;
  onError: (message: string) => void;
}

const PREFERRED_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/webm",
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return PREFERRED_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
}

function describeMediaError(
  err: unknown,
  t: (key: TranslationKey) => string,
): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return t("microphoneDenied");
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return t("microphoneMissing");
  if (name === "NotReadableError") return t("microphoneBusy");
  return t("microphoneStartFailed");
}

export function useRecorder({ onRecorded, onTooShort, onError }: Options) {
  const { t } = useLanguage();
  const [state, setState] = useState<RecorderState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const wantRecordingRef = useRef(false); // false once the button is released
  const startedAtRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const limitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbacks = useRef({ onRecorded, onTooShort, onError });
  callbacks.current = { onRecorded, onTooShort, onError };

  const clearTimers = () => {
    if (tickRef.current) clearInterval(tickRef.current);
    if (limitRef.current) clearTimeout(limitRef.current);
    tickRef.current = limitRef.current = null;
  };

  const stop = useCallback(() => {
    wantRecordingRef.current = false;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, []);

  const start = useCallback(async () => {
    if (wantRecordingRef.current) return;
    wantRecordingRef.current = true;

    if (!navigator.mediaDevices?.getUserMedia) {
      wantRecordingRef.current = false;
      callbacks.current.onError(t("secureRecording"));
      return;
    }
    const mimeType = pickMimeType();
    if (typeof MediaRecorder === "undefined") {
      wantRecordingRef.current = false;
      callbacks.current.onError(t("recorderUnsupported"));
      return;
    }

    setState("starting");
    try {
      if (!streamRef.current || !streamRef.current.active) {
        streamRef.current = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      }
    } catch (err) {
      wantRecordingRef.current = false;
      setState("idle");
      callbacks.current.onError(describeMediaError(err, t));
      return;
    }
    if (!wantRecordingRef.current) {
      setState("idle"); // released before the mic was ready
      return;
    }

    const recorder = new MediaRecorder(
      streamRef.current,
      mimeType ? { mimeType } : undefined,
    );
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      clearTimers();
      const durationMs = performance.now() - startedAtRef.current;
      recorderRef.current = null;
      wantRecordingRef.current = false;
      setState("idle");
      setElapsedMs(0);
      if (durationMs < MIN_RECORDING_MS || chunks.length === 0) {
        callbacks.current.onTooShort();
        return;
      }
      const type = recorder.mimeType || mimeType || "audio/webm";
      callbacks.current.onRecorded({
        blob: new Blob(chunks, { type }),
        mimeType: type,
        durationMs,
      });
    };
    recorder.onerror = () => {
      clearTimers();
      recorderRef.current = null;
      wantRecordingRef.current = false;
      setState("idle");
      callbacks.current.onError(t("recordingFailed"));
    };

    recorderRef.current = recorder;
    startedAtRef.current = performance.now();
    recorder.start(250);
    setState("recording");
    tickRef.current = setInterval(
      () => setElapsedMs(performance.now() - startedAtRef.current),
      100,
    );
    limitRef.current = setTimeout(stop, MAX_RECORDING_MS); // hard 60 s limit
  }, [stop]);

  // Release the microphone when leaving the channel.
  useEffect(
    () => () => {
      clearTimers();
      wantRecordingRef.current = false;
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    },
    [],
  );

  return { state, elapsedMs, start, stop };
}
