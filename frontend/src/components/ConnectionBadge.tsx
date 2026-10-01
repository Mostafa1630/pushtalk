import type { ConnectionState } from "../realtime/ChannelSocket";
import { useLanguage, type TranslationKey } from "../i18n";

const LABEL: Record<ConnectionState, TranslationKey> = {
  connecting: "connectionConnecting",
  open: "connectionLive",
  reconnecting: "connectionReconnecting",
  closed: "connectionDisconnected",
};

export function ConnectionBadge({
  state,
  retryInMs,
}: {
  state: ConnectionState;
  retryInMs: number | null;
}) {
  const { t } = useLanguage();
  const suffix =
    state === "reconnecting" && retryInMs
      ? ` (${t("retryIn", { seconds: Math.ceil(retryInMs / 1000) })})`
      : "";
  return (
    <span
      className={`conn conn--${state}`}
      data-testid="connection"
      data-state={state}
    >
      <span className="dot" /> {t(LABEL[state])}
      {suffix}
    </span>
  );
}
