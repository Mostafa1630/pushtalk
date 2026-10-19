import { useNavigate } from "react-router-dom";
import type { Member } from "../api/types";
import { API_BASE } from "../api/client";
import { channelApi } from "../api/endpoints";
import { useLanguage } from "../i18n";

const DEFAULT_AVATAR = "/images/avatar-placeholder.jpg";

interface Props {
  members: Member[];
  online: number[];
  selfUserId: number;
  adminUserId: number | null;
}

export function MemberList({
  members,
  online,
  selfUserId,
  adminUserId,
}: Props) {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const onlineSet = new Set(online);

  const handleStartDm = async (userId: number) => {
    try {
      const dm = await channelApi.createDirect({ user_id: userId });
      navigate(`/channels/${dm.id}`);
    } catch (e) {
      console.error("Failed to open DM:", e);
    }
  };
  const sorted = [...members].sort(
    (a, b) =>
      Number(onlineSet.has(b.user_id)) - Number(onlineSet.has(a.user_id)) ||
      a.username.localeCompare(b.username)
  );
  return (
    <aside className="members">
      <h3>
        {t("members")}{" "}
        <span className="muted">
          ({onlineSet.size} {t("online")})
        </span>
      </h3>
      <ul>
        {sorted.map((m) => (
          <li
            key={m.user_id}
            data-testid="member"
            data-online={onlineSet.has(m.user_id)}
          >
            <img
              className="avatar member-avatar"
              src={
                m.avatar_url
                  ? `${API_BASE}${m.avatar_url.replace(/^\/api/, "")}`
                  : DEFAULT_AVATAR
              }
              alt=""
              onError={(event) => {
                event.currentTarget.src = DEFAULT_AVATAR;
              }}
            />
            <span
              className={`dot${onlineSet.has(m.user_id) ? " dot--online" : ""}`}
            />
            <span>
              {m.username}
              {m.user_id === selfUserId && (
                <span className="muted"> ({t("you")})</span>
              )}
              {m.user_id === adminUserId && (
                <span className="admin-badge">{t("admin")}</span>
              )}
            </span>
            {m.user_id !== selfUserId && (
              <button
                type="button"
                className="icon-button member__dm"
                onClick={() => void handleStartDm(m.user_id)}
                title={t("startChat")}
                aria-label={t("startChat")}
                style={{
                  width: "26px",
                  height: "26px",
                  marginInlineStart: "auto",
                  fontSize: "0.85rem",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                  opacity: 0.85,
                  cursor: "pointer",
                }}
              >
                💬
              </button>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
