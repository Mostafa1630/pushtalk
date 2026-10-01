// Minimal fetch wrapper: adds the bearer token, parses the backend's
// consistent error envelope into ApiError, and maps network failures.

import type { ApiErrorBody } from "./types";

export const API_BASE: string = import.meta.env.VITE_API_URL ?? "/api";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let tokenProvider: () => string | null = () => null;
let unauthorizedHandler: () => void = () => {};

/** Wired by AuthProvider so API calls always use the current session. */
export function configureApiAuth(
  getToken: () => string | null,
  onUnauthorized: () => void,
): void {
  tokenProvider = getToken;
  unauthorizedHandler = onUnauthorized;
}

export function currentToken(): string | null {
  return tokenProvider();
}

interface RequestOptions {
  method?: string;
  json?: unknown;
  form?: FormData;
  signal?: AbortSignal;
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = tokenProvider();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    body = opts.form; // browser sets the multipart boundary
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body,
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      "Cannot reach the server. Check your connection.",
    );
  }
  if (!response.ok) {
    let parsed: ApiErrorBody | null = null;
    try {
      parsed = (await response.json()) as ApiErrorBody;
    } catch {
      /* non-JSON error page (e.g. proxy 502) */
    }
    const code = parsed?.error?.code ?? `HTTP_${response.status}`;
    const message = parsed?.error?.message ?? defaultMessage(response.status);
    // Only a rejected token means "log out" — not e.g. wrong login credentials.
    if (response.status === 401 && token && code !== "INVALID_CREDENTIALS")
      unauthorizedHandler();
    throw new ApiError(response.status, code, message, parsed?.error?.details);
  }
  return response;
}

function defaultMessage(status: number): string {
  if (status >= 500) return "The server had a problem. Please try again.";
  if (status === 413) return "The recording is too large.";
  return `Request failed (${status})`;
}

export async function apiJson<T>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const response = await send(path, opts);
  return (await response.json()) as T;
}

export async function apiVoid(
  path: string,
  opts: RequestOptions = {},
): Promise<void> {
  await send(path, opts);
}

export async function apiBlob(
  path: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await send(path, { signal });
  return response.blob();
}
