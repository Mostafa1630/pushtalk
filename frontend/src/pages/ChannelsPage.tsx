import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE, ApiError } from "../api/client";
import { channelApi } from "../api/endpoints";
import type { Channel } from "../api/types";
import { useLanguage } from "../i18n";
import { channelSchema, validateForm } from "../validation";

const DEFAULT_CHANNEL_IMAGE = "/images/channel-community.jpg";

function imageSource(path: string | null): string {
  return path
    ? `${API_BASE}${path.replace(/^\/api/, "")}`
    : DEFAULT_CHANNEL_IMAGE;
}

export function ChannelsPage() {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState<string | null>(null);
  const [newChannelId, setNewChannelId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const feedbackTimer = useRef<number | null>(null);

  const load = useCallback(() => {
    channelApi
      .list()
      .then(setChannels)
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : t("channelLoadError")),
      );
  }, [t]);

  useEffect(load, [load]);

  useEffect(
    () => () => {
      if (feedbackTimer.current !== null)
        window.clearTimeout(feedbackTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!photo) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    const validationErrors = await validateForm(
      channelSchema,
      { name, description },
      t,
    );
    setFieldErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;
    setBusy(true);
    let channelCreated = false;
    try {
      let ch = await channelApi.create(name.trim(), description.trim());
      channelCreated = true;
      if (photo) ch = await channelApi.uploadImage(ch.id, photo);
      setChannels((current) =>
        [...(current ?? []).filter((item) => item.id !== ch.id), ch].sort(
          (a, b) => a.name.localeCompare(b.name),
        ),
      );
      setName("");
      setDescription("");
      setPhoto(null);
      setNewChannelId(ch.id);
      setSuccess(t("channelCreated"));
      if (feedbackTimer.current !== null)
        window.clearTimeout(feedbackTimer.current);
      feedbackTimer.current = window.setTimeout(() => {
        setSuccess(null);
        setNewChannelId(null);
      }, 3600);
    } catch (err) {
      if (err instanceof ApiError && err.code === "VALIDATION_ERROR") {
        setError(t("invalidChannelName"));
      } else if (err instanceof ApiError && err.code === "CHANNEL_EXISTS") {
        setError(t("channelExists"));
      } else if (channelCreated && photo && err instanceof ApiError) {
        setError(t("channelPhotoError"));
        load();
      } else {
        setError(
          err instanceof ApiError ? err.message : t("channelCreateError"),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const join = async (ch: Channel) => {
    setError(null);
    try {
      if (!ch.is_member) await channelApi.join(ch.id);
      navigate(`/channels/${ch.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("channelJoinError"));
      load();
    }
  };

  return (
    <div className="page channels-page">
      <section className="card channel-create">
        <h2>{t("createChannel")}</h2>
        {success && (
          <div className="toast toast--inline" role="status">
            {success}
          </div>
        )}
        <form className="channel-create__form" onSubmit={create} noValidate>
          <label className="channel-photo-picker">
            <img
              src={preview ?? DEFAULT_CHANNEL_IMAGE}
              alt={t("channelPhotoAlt")}
            />
            <span
              className="channel-photo-picker__edit"
              aria-hidden="true"
              title={t("photoEdit")}
            >
              ✎
            </span>
            <span>{t("choosePhoto")}</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => setPhoto(event.target.files?.[0] ?? null)}
            />
          </label>
          <div className="channel-create__fields">
            <label className={fieldErrors.name ? "field--invalid" : ""}>
              {t("channelName")}
              <input
                placeholder={t("channelNamePlaceholder")}
                className={fieldErrors.name ? "input--invalid" : ""}
                aria-invalid={Boolean(fieldErrors.name)}
                value={name}
                onChange={(event) => {
                  setName(event.target.value.toLowerCase());
                  setFieldErrors((current) => {
                    const next = { ...current };
                    delete next.name;
                    return next;
                  });
                }}
                required
                minLength={2}
                maxLength={64}
              />
              {fieldErrors.name && (
                <span className="field-error" role="alert">
                  {fieldErrors.name}
                </span>
              )}
            </label>
            <label className={fieldErrors.description ? "field--invalid" : ""}>
              {t("channelDescription")}
              <textarea
                placeholder={t("channelDescriptionPlaceholder")}
                className={fieldErrors.description ? "input--invalid" : ""}
                aria-invalid={Boolean(fieldErrors.description)}
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                  setFieldErrors((current) => {
                    const next = { ...current };
                    delete next.description;
                    return next;
                  });
                }}
                maxLength={200}
                rows={2}
              />
              {fieldErrors.description && (
                <span className="field-error" role="alert">
                  {fieldErrors.description}
                </span>
              )}
            </label>
          </div>
          <button
            className="primary channel-create__submit"
            type="submit"
            disabled={busy}
          >
            {busy ? t("loading") : t("create")}
          </button>
        </form>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
      </section>

      <section className="card channel-directory">
        <h2>{t("channels")}</h2>
        {channels === null ? (
          <p className="muted">{t("loading")}</p>
        ) : channels.length === 0 ? (
          <p className="muted">{t("noChannels")}</p>
        ) : (
          <ul className="channel-list">
            {channels.map((ch) => (
              <li key={ch.id}>
                <button
                  className={`channel-row${newChannelId === ch.id ? " channel-row--new" : ""}`}
                  onClick={() => join(ch)}
                >
                  <img
                    className="avatar avatar--channel"
                    src={imageSource(ch.image_url)}
                    alt=""
                    onError={(event) => {
                      event.currentTarget.src = DEFAULT_CHANNEL_IMAGE;
                    }}
                  />
                  <span className="channel-row__copy">
                    <strong>#{ch.name}</strong>
                    <span className="channel-row__description">
                      {ch.description || t("noDescription")}
                    </span>
                  </span>
                  <span className="channel-row__meta">
                    <span>{t("memberCount", { count: ch.member_count })}</span>
                    <span
                      className={
                        ch.is_member ? "channel-row__open" : "channel-row__join"
                      }
                    >
                      {ch.is_member ? t("open") : t("join")}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
