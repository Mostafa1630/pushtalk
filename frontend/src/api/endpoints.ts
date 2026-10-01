import { apiBlob, apiJson, apiVoid } from "./client";
import type {
  Channel,
  Member,
  MessageDTO,
  MessagePage,
  TokenResponse,
  User,
} from "./types";

export const authApi = {
  register: (username: string, password: string) =>
    apiJson<TokenResponse>("/auth/register", {
      method: "POST",
      json: { username, password },
    }),
  login: (username: string, password: string) =>
    apiJson<TokenResponse>("/auth/login", {
      method: "POST",
      json: { username, password },
    }),
  me: () => apiJson<User>("/auth/me"),
  updateProfile: (username: string) =>
    apiJson<User>("/auth/me", { method: "PATCH", json: { username } }),
  changePassword: (currentPassword: string, newPassword: string) =>
    apiVoid("/auth/me/password", {
      method: "PATCH",
      json: {
        current_password: currentPassword,
        new_password: newPassword,
      },
    }),
  uploadAvatar: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return apiJson<User>("/auth/me/avatar", { method: "POST", form });
  },
};

export const channelApi = {
  list: () => apiJson<Channel[]>("/channels"),
  get: (id: number) => apiJson<Channel>(`/channels/${id}`),
  create: (name: string, description: string) =>
    apiJson<Channel>("/channels", {
      method: "POST",
      json: { name, description },
    }),
  uploadImage: (id: number, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return apiJson<Channel>(`/channels/${id}/image`, { method: "POST", form });
  },
  update: (id: number, name: string, description: string) =>
    apiJson<Channel>(`/channels/${id}`, {
      method: "PATCH",
      json: { name, description },
    }),
  delete: (id: number) => apiVoid(`/channels/${id}`, { method: "DELETE" }),
  join: (id: number) =>
    apiJson<Channel>(`/channels/${id}/join`, { method: "POST" }),
  members: (id: number) => apiJson<Member[]>(`/channels/${id}/members`),
};

export const messageApi = {
  /** Latest page of history (no cursor) or catch-up after a known seq. */
  list: (
    channelId: number,
    params: { afterSeq?: number; limit?: number } = {},
  ) => {
    const q = new URLSearchParams();
    if (params.afterSeq !== undefined)
      q.set("after_seq", String(params.afterSeq));
    if (params.limit !== undefined) q.set("limit", String(params.limit));
    const qs = q.toString();
    return apiJson<MessagePage>(
      `/channels/${channelId}/messages${qs ? `?${qs}` : ""}`,
    );
  },
  upload: (channelId: number, audio: Blob, clientId: string) => {
    const form = new FormData();
    const ext = audio.type.includes("ogg")
      ? "ogg"
      : audio.type.includes("mp4")
        ? "m4a"
        : "webm";
    form.append("file", audio, `recording.${ext}`);
    form.append("client_id", clientId);
    return apiJson<MessageDTO>(`/channels/${channelId}/messages`, {
      method: "POST",
      form,
    });
  },
  /** Protected media: fetched with the bearer token, never a public URL. */
  audio: (messageId: string, signal?: AbortSignal) =>
    apiBlob(`/messages/${messageId}/audio`, signal),
};
