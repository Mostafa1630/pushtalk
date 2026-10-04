// Top-bar bell: unread badge + dropdown panel (newest first, time-ago,
// unread highlighted, single check = read one, double check = read all,
// click a notification to jump to its channel). State comes from the global
// NotificationFeed; ChannelSession forwards realtime notification.new events
// into the same feed.

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type UIEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import type { NotificationDTO } from "../api/types";
import { useLanguage } from "../i18n";
import { notificationFeed } from "../notifications/NotificationFeed";
import { timeAgo } from "../notifications/timeAgo";

type Translate = ReturnType<typeof useLanguage>["t"];

function notificationText(n: NotificationDTO, t: Translate): string {
  if (n.type === "channel_joined" && n.channel_name)
    return t("notificationJoined", { name: n.channel_name });
  if (n.type === "channel_message" && n.channel_name && n.actor_username)
    return t("notificationChannelMessage", {
      name: n.channel_name,
      sender: n.actor_username,
    });
  // Deleted channel/user or unknown type: the server's stored fallback text.
  return n.body;
}

function BellIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function DoubleCheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 12.5 6.5 16.5 14 7" />
      <path d="M10 15.5 12 17.5 21 7" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
    </svg>
  );
}

function HashIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </svg>
  );
}

function NotificationRow({
  notification,
  onOpen,
}: {
  notification: NotificationDTO;
  onOpen: (n: NotificationDTO) => void;
}) {
  const { t } = useLanguage();
  const ago = timeAgo(notification.created_at);
  return (
    <li
      className={`notifications-item${notification.is_read ? "" : " notifications-item--unread"}`}
    >
      <button
        type="button"
        className="notifications-item__main"
        onClick={() => onOpen(notification)}
      >
        <span className="notifications-item__icon" aria-hidden="true">
          {notification.type === "channel_message" ? <MicIcon /> : <HashIcon />}
        </span>
        <span className="notifications-item__body">
          <span className="notifications-item__text">
            {notificationText(notification, t)}
          </span>
          {ago && (
            <span className="notifications-item__time">
              {t(ago.key, ago.count !== undefined ? { count: ago.count } : undefined)}
            </span>
          )}
        </span>
      </button>
      {!notification.is_read && (
        <button
          type="button"
          className="notifications-item__read"
          aria-label={t("markAsRead")}
          title={t("markAsRead")}
          onClick={() => void notificationFeed.markRead(notification.id)}
        >
          <CheckIcon />
        </button>
      )}
    </li>
  );
}

export function NotificationsMenu() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const state = useSyncExternalStore(
    notificationFeed.subscribe,
    notificationFeed.getSnapshot,
  );

  // Session lifecycle: badge count follows login/logout; re-sync when the
  // tab regains focus (notifications may arrive while no socket is open).
  useEffect(() => {
    if (!user) {
      notificationFeed.stop();
      return;
    }
    void notificationFeed.start();
    const onVisible = () => {
      if (document.visibilityState === "visible")
        void notificationFeed.refreshCount();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [user]);

  // Every open refetches the first page — the server is the source of truth.
  useEffect(() => {
    if (open) void notificationFeed.open();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node))
        setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!user) return null;

  const openItem = (n: NotificationDTO) => {
    setOpen(false);
    if (!n.is_read) void notificationFeed.markRead(n.id);
    if (n.related_id !== null) navigate(`/channels/${n.related_id}`);
  };

  const onListScroll = (event: UIEvent<HTMLUListElement>) => {
    const el = event.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 60)
      void notificationFeed.loadMore();
  };

  return (
    <div className="notifications-wrap" ref={wrapRef}>
      <button
        type="button"
        className="notifications-trigger"
        aria-label={
          state.unreadCount > 0
            ? `${t("notifications")} — ${t("unreadNotifications", { count: state.unreadCount })}`
            : t("notifications")
        }
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <BellIcon />
        {state.unreadCount > 0 && (
          <span className="notifications-badge" aria-hidden="true">
            {state.unreadCount > 9 ? "9+" : state.unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div className="notifications-panel">
          <header className="notifications-header">
            <strong>{t("notifications")}</strong>
            {state.unreadCount > 0 && (
              <button
                type="button"
                className="notifications-read-all"
                onClick={() => void notificationFeed.markAllRead()}
              >
                <DoubleCheckIcon />
                <span>{t("markAllRead")}</span>
              </button>
            )}
          </header>
          <ul className="notifications-list" onScroll={onListScroll}>
            {state.loading && (
              <li className="notifications-hint">{t("loading")}</li>
            )}
            {!state.loading && state.error && (
              <li className="notifications-hint">
                {t("notificationLoadError")}
              </li>
            )}
            {!state.loading && !state.error && state.items.length === 0 && (
              <li className="notifications-hint">{t("noNotifications")}</li>
            )}
            {state.items.map((n) => (
              <NotificationRow key={n.id} notification={n} onOpen={openItem} />
            ))}
            {state.loadingMore && (
              <li className="notifications-hint">{t("loading")}</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
