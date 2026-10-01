/**
 * Same user, several tabs on the same channel: only ONE tab auto-plays.
 *
 * Uses the Web Locks API: every tab requests an exclusive lock named after
 * the channel; the holder is the "playback leader". When the leader tab
 * closes (or navigates away) the browser releases the lock and the next tab
 * becomes leader automatically. Browsers without Web Locks fall back to
 * "every tab is leader" (documented limitation).
 */
export function acquirePlaybackLeadership(channelId: number, onLeader: (isLeader: boolean) => void): () => void {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks) {
    onLeader(true);
    return () => {};
  }
  const controller = new AbortController();
  let release: (() => void) | null = null;
  locks
    .request(`pushtalk-playback-${channelId}`, { signal: controller.signal }, () => {
      onLeader(true);
      // Hold the lock until this tab gives it up.
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    })
    .catch(() => {
      /* aborted before acquiring: we were a follower and are leaving */
    });
  onLeader(false);
  return () => {
    controller.abort();
    release?.();
  };
}
