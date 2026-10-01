// Wire types. These mirror the backend Pydantic schemas (app/schemas/*.py)
// and WebSocket events (app/realtime/events.py).

export interface User {
  id: number;
  username: string;
  avatar_url?: string | null;
}

export interface TokenResponse {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  user: User;
}

export interface Channel {
  id: number;
  name: string;
  description: string;
  created_at: string;
  created_by: number | null;
  member_count: number;
  is_member: boolean;
  is_owner: boolean;
  image_url: string | null;
}

export interface Member {
  user_id: number;
  username: string;
  avatar_url: string | null;
  online: boolean;
  joined_at: string;
}

export type ServerMessageStatus = "processing" | "ready" | "failed";

export interface ReceiptSummary {
  recipients: number;
  delivered: number;
  played: number;
}

export interface MessageDTO {
  id: string;
  client_id: string;
  channel_id: number;
  sender_id: number;
  sender_username: string;
  sender_avatar_url: string | null;
  status: ServerMessageStatus;
  seq: number | null;
  duration_ms: number | null;
  waveform: number[] | null;
  error_code: string | null;
  created_at: string;
  receipts: ReceiptSummary | null;
  played_by_me: boolean;
}

export interface MessagePage {
  messages: MessageDTO[];
  latest_seq: number;
  has_more: boolean;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    request_id?: string;
  };
}

// ---- WebSocket: server -> client ------------------------------------------
export type ServerEvent =
  | { type: "ready"; user_id: number; latest_seq: number; online: number[] }
  | { type: "message.new"; message: MessageDTO }
  | {
      type: "message.failed";
      message_id: string;
      client_id: string;
      sender_id: number;
      error_code: string;
    }
  | {
      type: "message.status";
      message_id: string;
      user_id: number;
      kind: "delivered" | "played";
      receipts: ReceiptSummary;
    }
  | { type: "presence"; online: number[] }
  | { type: "resync" }
  | { type: "pong" }
  | { type: "error"; code: string; message: string };

// ---- WebSocket: client -> server ------------------------------------------
export type ClientFrame =
  | { type: "hello"; token: string }
  | { type: "ping" }
  | { type: "ack"; delivered: string[] }
  | { type: "played"; message_id: string };
