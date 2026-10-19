import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { API_BASE } from "../api/client";
import { channelApi } from "../api/endpoints";
import type { Channel } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { ChannelSettingsDialog } from "../components/ChannelSettingsDialog";
import { MemberList } from "../components/MemberList";
import { MessageItem } from "../components/MessageItem";
import { PushToTalkButton } from "../components/PushToTalkButton";
import { useChannelSession } from "../hooks/useChannelSession";
import { useLanguage } from "../i18n";
import { daySeparator } from "../messages/dateSeparators";
import { useRecorder } from "../recording/useRecorder";

const DEFAULT_CHANNEL_IMAGE = "/images/channel-community.jpg";

export function ChannelPage() {
  const { channelId } = useParams();
  const id = Number(channelId);
  const { user } = useAuth();
  const navigate = useNavigate();
  const { language, t } = useLanguage();
  const { session, state } = useChannelSession(id, user!.id);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const atBottomRef = useRef(true);
  const prependRef = useRef<{
    height: number;
    top: number;
    firstKey: string | null;
  } | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [manageChannel, setManageChannel] = useState<Channel | null>(null);

  useEffect(() => {
    channelApi
      .get(id)
      .then(setChannel)
      .catch(() => undefined);
  }, [id]);

  const recorder = useRecorder({
    onRecorded: (rec) => void session?.sendRecording(rec.blob),
    onTooShort: () => setLocalNotice(t("holdLonger")),
    onError: (message) => setLocalNotice(message),
  });

  // Half-duplex like a real walkie-talkie: incoming audio waits while you talk.
  const recording = recorder.state !== "idle";
  useEffect(() => {
    session?.setRecording(recording);
  }, [session, recording]);

  const press = useCallback(() => {
    setLocalNotice(null);
    session?.unlockAudio(); // the press itself is a user gesture
    void recorder.start();
  }, [session, recorder]);

  const firstKey = state.messages[0]?.key ?? null;

  // Keep the newest message in view, but only when the user is at the bottom.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (atBottomRef.current) {
      list.lastElementChild?.scrollIntoView({ block: "nearest" });
    }
  }, [state.messages.length]);

  // After older messages are prepended, keep the viewport anchored where it was.
  useLayoutEffect(() => {
    const list = listRef.current;
    const snap = prependRef.current;
    if (!list || !snap) return;
    prependRef.current = null;
    if (firstKey !== null && firstKey !== snap.firstKey) {
      list.scrollTop = list.scrollHeight - snap.height + snap.top;
    }
  }, [firstKey]);

  const onScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    atBottomRef.current =
      list.scrollHeight - list.scrollTop - list.clientHeight <= 60;
    if (
      list.scrollTop > 80 ||
      state.loading ||
      state.loadingOlder ||
      !state.hasMore
    )
      return;
    prependRef.current = {
      height: list.scrollHeight,
      top: list.scrollTop,
      firstKey: state.messages[0]?.key ?? null,
    };
    void session?.loadOlder();
  }, [session, state.loading, state.loadingOlder, state.hasMore, state.messages]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.addEventListener("scroll", onScroll, { passive: true });
    return () => list.removeEventListener("scroll", onScroll);
  }, [onScroll]);

  const { playback } = state;
  const playbackPrefix = "Couldn't play the message from ";
  const playbackSuffix = ". Skipped to the next one.";
  const playbackNotice = state.notice?.startsWith(playbackPrefix)
    ? state.notice
    : null;
  const playbackSender = playbackNotice
    ? playbackNotice.slice(
        playbackPrefix.length,
        playbackNotice.lastIndexOf(playbackSuffix),
      )
    : "";
  const notice = playbackNotice
    ? t("playbackError", { name: playbackSender || t("members") })
    : state.notice;
  const queuedIds = new Set(playback.queued.map((q) => q.id));
  const now = new Date();
  const blocked = playback.paused.includes("blocked");
  const unheard = state.messages.filter(
    (m) => m.unheard && m.senderId !== user!.id,
  ).length;

  if (!Number.isInteger(id) || id <= 0)
    return <div className="page error">{t("invalidChannel")}</div>;

  return (
    <div className="channel-page">
      <MemberList
        members={state.members}
        online={state.online}
        selfUserId={user!.id}
        adminUserId={channel?.created_by ?? null}
      />
      <main className="channel-main">
        <header className="channel-header">
          <Link
            to="/channels"
            className="channel-back"
            aria-label={t("channelsBack")}
          >
            <span aria-hidden="true">{language === "ar" ? "→" : "←"}</span>
          </Link>
          <img
            className="avatar channel-header__avatar"
            src={
              channel?.image_url
                ? `${API_BASE}${channel.image_url.replace(/^\/api/, "")}`
                : DEFAULT_CHANNEL_IMAGE
            }
            alt=""
            onError={(event) => {
              event.currentTarget.src = DEFAULT_CHANNEL_IMAGE;
            }}
          />
          <div className="channel-header__identity">
            <h2 className="channel-title">
              {channel
                ? channel.is_direct
                  ? `@${channel.name}`
                  : `#${channel.name}`
                : ""}
            </h2>
            {channel?.description && <p>{channel.description}</p>}
          </div>
          <ConnectionBadge
            state={state.connection}
            retryInMs={state.retryInMs}
          />
          {channel?.is_owner && !channel?.is_direct && (
            <button
              type="button"
              className="icon-button channel-header__settings"
              aria-label={t("manageChannel")}
              title={t("manageChannel")}
              onClick={() => setManageChannel(channel)}
            >
              ⋯
            </button>
          )}
        </header>

        {state.fatalError && (
          <div className="banner banner--error" role="alert">
            {state.fatalError === "Could not load the channel."
              ? t("channelLoadError")
              : state.fatalError}{" "}
            <Link to="/channels">{t("channelsBack")}</Link>
          </div>
        )}
        {blocked && state.isLeader && (
          <button
            className="banner banner--action"
            data-testid="unlock-audio"
            onClick={() => session?.unlockAudio()}
          >
            🔈 {t("clickEnableAudio")}
            {playback.queued.length
              ? ` (${t("waitingCount", { count: playback.queued.length })})`
              : ""}
          </button>
        )}
        {!state.isLeader && !state.loading && (
          <div className="banner">{t("otherTabNotice")}</div>
        )}
        {(notice || localNotice) && (
          <div className="banner banner--warn" role="status">
            {notice ?? localNotice}
          </div>
        )}

        {state.loading ? (
          <p className="muted center">{t("loadingMessages")}</p>
        ) : (
          <ul className="messages" ref={listRef} data-testid="messages">
            {state.loadingOlder && (
              <li className="messages__older" aria-live="polite">
                <span className="spinner" aria-hidden="true" />
                {t("loadingOlder")}
              </li>
            )}
            {state.messages.length === 0 && !state.loadingOlder && (
              <li className="muted center">{t("noMessages")}</li>
            )}
            {state.messages.map((m, index) => {
              const separator = daySeparator(
                m.createdAt,
                state.messages[index - 1]?.createdAt ?? null,
                language,
                now,
              );
              // role="separator" drops the text from the a11y tree, so name it.
              const day = separator
                ? separator.kind === "label"
                  ? t(separator.key)
                  : separator.text
                : null;
              return (
                <Fragment key={m.key}>
                  {day && (
                    <li className="messages__day" role="separator" aria-label={day}>
                      {day}
                    </li>
                  )}
                  <MessageItem
                    message={m}
                    isOwn={m.senderId === user!.id}
                    isAdmin={m.senderId === channel?.created_by}
                    isPlaying={playback.current?.id === m.id && m.id !== null}
                    isPaused={playback.userPaused}
                    isQueued={m.id !== null && queuedIds.has(m.id)}
                    rate={state.playbackRate}
                    onTogglePlay={() => session?.togglePlayback(m.key)}
                    onCycleRate={() => session?.cyclePlaybackRate()}
                    onRetry={() => void session?.retryUpload(m.key)}
                  />
                </Fragment>
              );
            })}
          </ul>
        )}

        <footer className="channel-footer">
          {unheard > 0 && (
            <button
              onClick={() => session?.playUnheard()}
              data-testid="play-unheard"
            >
              ▶ {t("playUnheard", { count: unheard })}
            </button>
          )}
          {recording && playback.queued.length > 0 && (
            <span className="muted">
              {t("waitingRelease", { count: playback.queued.length })}
            </span>
          )}
          <PushToTalkButton
            state={recorder.state}
            elapsedMs={recorder.elapsedMs}
            disabled={state.loading || state.fatalError !== null}
            onPress={press}
            onRelease={recorder.stop}
          />
        </footer>
      </main>
      {manageChannel && (
        <ChannelSettingsDialog
          channel={manageChannel}
          onClose={() => setManageChannel(null)}
          onUpdated={(updated) => {
            setChannel(updated);
            setManageChannel(updated);
          }}
          onDeleted={() => navigate("/channels", { replace: true })}
        />
      )}
    </div>
  );
}
