import { useEffect, useState, useSyncExternalStore } from "react";
import { currentToken } from "../api/client";
import { HtmlAudioPlayer } from "../playback/HtmlAudioPlayer";
import { ChannelSession, type SessionState } from "../session/ChannelSession";

const EMPTY: SessionState = {
  loading: true,
  messages: [],
  members: [],
  online: [],
  connection: "connecting",
  retryInMs: null,
  playback: { current: null, queued: [], paused: [] },
  isLeader: false,
  fatalError: null,
  notice: null,
};

const noopSubscribe = () => () => {};

/** Creates a ChannelSession for the mounted channel page and tears it down on leave. */
export function useChannelSession(channelId: number, selfUserId: number) {
  const [session, setSession] = useState<ChannelSession | null>(null);

  useEffect(() => {
    const s = new ChannelSession(channelId, selfUserId, currentToken, new HtmlAudioPlayer());
    setSession(s);
    void s.start();
    return () => s.destroy();
  }, [channelId, selfUserId]);

  const state = useSyncExternalStore(session?.subscribe ?? noopSubscribe, () => session?.getSnapshot() ?? EMPTY);
  return { session, state };
}
