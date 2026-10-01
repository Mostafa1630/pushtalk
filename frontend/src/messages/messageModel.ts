// Client-side message model: merges optimistic local state with server
// updates that may arrive in any order (HTTP response vs. WebSocket event).

import type { MessageDTO, ReceiptSummary } from "../api/types";

/**
 * uploading      local only: HTTP upload in progress
 * upload_failed  local only: network/server error, can be retried (same client_id)
 * processing     accepted by the server, worker is normalizing it
 * failed         rejected (validation) or processing failed - final
 * ready          processed and broadcast ("sent")
 */
export type LocalStatus =
  | "uploading"
  | "upload_failed"
  | "processing"
  | "failed"
  | "ready";

export interface ChatMessage {
  key: string; // client_id: stable across optimistic -> server states
  id: string | null; // server id, null until the upload response arrives
  senderId: number;
  senderName: string;
  senderAvatarUrl: string | null;
  status: LocalStatus;
  seq: number | null;
  durationMs: number | null;
  waveform: number[] | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  receipts: ReceiptSummary | null;
  playedByMe: boolean;
  /** Arrived while you weren't listening (history / old catch-up): not auto-played. */
  unheard: boolean;
  /** Kept only for own messages until the server accepted them, for retry. */
  blob?: Blob;
}

const RANK: Record<LocalStatus, number> = {
  uploading: 0,
  upload_failed: 0,
  processing: 1,
  ready: 2,
  failed: 2,
};

export function fromDTO(dto: MessageDTO): ChatMessage {
  return {
    key: dto.client_id,
    id: dto.id,
    senderId: dto.sender_id,
    senderName: dto.sender_username,
    senderAvatarUrl: dto.sender_avatar_url,
    status: dto.status,
    seq: dto.seq,
    durationMs: dto.duration_ms,
    waveform: dto.waveform,
    errorCode: dto.error_code,
    errorMessage: dto.error_code ? describeErrorCode(dto.error_code) : null,
    createdAt: dto.created_at,
    receipts: dto.receipts,
    playedByMe: dto.played_by_me,
    unheard: false,
  };
}

/** Merge an update into an existing message without ever going "backwards". */
export function mergeMessage(
  existing: ChatMessage | undefined,
  update: ChatMessage,
): ChatMessage {
  if (!existing) return update;
  if (RANK[update.status] < RANK[existing.status]) {
    // e.g. the 202 "processing" response arrives after the "ready" WS event.
    return { ...existing, id: existing.id ?? update.id };
  }
  return {
    ...existing,
    ...update,
    receipts: update.receipts ?? existing.receipts,
    playedByMe: existing.playedByMe || update.playedByMe,
    unheard: update.unheard && !existing.playedByMe,
    blob:
      update.status === "upload_failed" || update.status === "uploading"
        ? (update.blob ?? existing.blob)
        : undefined,
  };
}

/** Ready messages in seq order; own in-flight / failed ones after them (outbox). */
export function sortMessages(messages: Iterable<ChatMessage>): ChatMessage[] {
  const all = [...messages];
  const ready = all
    .filter((m) => m.status === "ready")
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const pending = all
    .filter((m) => m.status !== "ready")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return [...ready, ...pending];
}

/** Human status label for the sender's own messages. */
export function ownStatusLabel(m: ChatMessage): string {
  switch (m.status) {
    case "uploading":
      return "Uploading…";
    case "upload_failed":
      return "Not sent";
    case "processing":
      return "Processing…";
    case "failed":
      return "Failed";
    case "ready": {
      const r = m.receipts;
      if (!r || r.recipients === 0) return "Sent";
      if (r.played > 0)
        return r.played >= r.recipients
          ? "Played"
          : `Played ${r.played}/${r.recipients}`;
      if (r.delivered > 0)
        return r.delivered >= r.recipients
          ? "Delivered"
          : `Delivered ${r.delivered}/${r.recipients}`;
      return "Sent";
    }
  }
}

const ERROR_TEXT: Record<string, string> = {
  AUDIO_TOO_SHORT: "Recording was too short (min 0.5 s).",
  AUDIO_TOO_LONG: "Recording was too long (max 60 s).",
  AUDIO_INVALID: "The recording was corrupted.",
  EMPTY_FILE: "The recording was empty.",
  FILE_TOO_LARGE: "The recording is too large.",
  UNSUPPORTED_MEDIA_TYPE: "This audio format is not supported.",
  UNRECOGNIZED_AUDIO_CONTENT: "This audio format is not supported.",
  FFMPEG_FAILED: "The server could not process this audio.",
  AUDIO_ERROR: "The server could not process this audio.",
  PROCESSING_TIMEOUT: "Processing took too long.",
  PROCESSING_ERROR: "Processing failed on the server.",
  QUEUE_UNAVAILABLE: "Processing queue unavailable. Try again.",
  UPLOAD_MISSING: "The upload was lost on the server.",
  STORAGE_ERROR: "The server could not store the audio.",
  FFMPEG_UNAVAILABLE: "Audio processing is unavailable.",
};

export function describeErrorCode(code: string): string {
  return ERROR_TEXT[code] ?? "Processing failed.";
}
