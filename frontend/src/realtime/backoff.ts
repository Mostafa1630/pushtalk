/**
 * Exponential backoff with "full jitter": delay is random in [base/2, cap],
 * where cap doubles each attempt up to maxMs. Jitter prevents every client
 * from reconnecting at the same instant after a server restart.
 */
export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  random?: () => number; // injectable for tests
}

export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 500;
  const max = opts.maxMs ?? 15_000;
  const random = opts.random ?? Math.random;
  const cap = Math.min(max, base * 2 ** Math.max(0, attempt));
  const floor = Math.min(base / 2, cap);
  return Math.round(floor + random() * (cap - floor));
}
