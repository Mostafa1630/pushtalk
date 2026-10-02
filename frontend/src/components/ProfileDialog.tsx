import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE, ApiError } from "../api/client";
import { channelApi } from "../api/endpoints";
import type { Channel } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { ChannelSettingsDialog } from "./ChannelSettingsDialog";
import { useLanguage } from "../i18n";
import { profileSchema, validateForm } from "../validation";

const DEFAULT_AVATAR = "/images/avatar-placeholder.jpg";
const MAX_PROFILE_PHOTO_BYTES = 2 * 1024 * 1024;
const PROFILE_ERROR_TRANSLATIONS = {
  USERNAME_TAKEN: "usernameTaken",
  FILE_TOO_LARGE: "profilePhotoTooLarge",
  EMPTY_FILE: "profilePhotoUnsupported",
  UNSUPPORTED_MEDIA_TYPE: "profilePhotoUnsupported",
  UNRECOGNIZED_IMAGE: "profilePhotoUnsupported",
  STORAGE_UNAVAILABLE: "profilePhotoStorageError",
} as const;

function imageSource(path: string | null | undefined): string {
  return path ? `${API_BASE}${path.replace(/^\/api/, "")}` : DEFAULT_AVATAR;
}

export function ProfileDialog({ onClose }: { onClose: () => void }) {
  const { user, updateProfile, updateAvatar } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [username, setUsername] = useState(user?.username ?? "");
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [ownedChannels, setOwnedChannels] = useState<Channel[] | null>(null);
  const [managingChannel, setManagingChannel] = useState<Channel | null>(null);

  useEffect(() => {
    let active = true;
    channelApi
      .list()
      .then((channels) => {
        if (active)
          setOwnedChannels(channels.filter((channel) => channel.is_owner));
      })
      .catch(() => {
        if (active) setOwnedChannels([]);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!photo) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const validationErrors = await validateForm(profileSchema, { username }, t);
    setFieldErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;
    setBusy(true);
    try {
      if (username.trim() !== user?.username)
        await updateProfile(username.trim());
      if (photo) await updateAvatar(photo);
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? PROFILE_ERROR_TRANSLATIONS[
              err.code as keyof typeof PROFILE_ERROR_TRANSLATIONS
            ]
            ? t(
                PROFILE_ERROR_TRANSLATIONS[
                  err.code as keyof typeof PROFILE_ERROR_TRANSLATIONS
                ],
              )
            : err.message
          : t("profileSaveError"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="modal-backdrop" onMouseDown={onClose}>
        <section
          className="modal profile-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="profile-title"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <h2 id="profile-title">{t("profileTitle")}</h2>
          <form onSubmit={save} noValidate>
            <label className="profile-photo-picker">
              <img
                className="avatar avatar--large"
                src={preview ?? imageSource(user?.avatar_url)}
                alt={t("defaultAvatarAlt")}
                onError={(event) => {
                  event.currentTarget.src = DEFAULT_AVATAR;
                }}
              />
              <span>{t("changePhoto")}</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(event) => {
                  const selected = event.target.files?.[0] ?? null;
                  if (selected && selected.size > MAX_PROFILE_PHOTO_BYTES) {
                    setPhoto(null);
                    event.currentTarget.value = "";
                    setError(t("profilePhotoTooLarge"));
                    return;
                  }
                  if (
                    selected?.type &&
                    !["image/jpeg", "image/png", "image/webp"].includes(
                      selected.type,
                    )
                  ) {
                    setPhoto(null);
                    event.currentTarget.value = "";
                    setError(t("profilePhotoUnsupported"));
                    return;
                  }
                  setError(null);
                  setPhoto(selected);
                }}
              />
            </label>
            <label
              className={`profile-name-field${fieldErrors.username ? " field--invalid" : ""}`}
            >
              {t("displayName")}
              <input
                name="username"
                className={fieldErrors.username ? "input--invalid" : ""}
                aria-invalid={Boolean(fieldErrors.username)}
                autoComplete="username"
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setFieldErrors((current) => {
                    const next = { ...current };
                    delete next.username;
                    return next;
                  });
                }}
                required
                minLength={3}
                maxLength={32}
              />
              {fieldErrors.username && (
                <span className="field-error" role="alert">
                  {fieldErrors.username}
                </span>
              )}
            </label>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <div className="modal-actions">
              <button type="button" onClick={onClose}>
                {t("cancel")}
              </button>
              <button className="primary" type="submit" disabled={busy}>
                {busy ? t("loading") : t("saveChanges")}
              </button>
            </div>
          </form>
          <section className="profile-owned-channels">
            <h3>{t("myChannels")}</h3>
            {ownedChannels === null ? (
              <p className="muted">{t("loading")}</p>
            ) : ownedChannels.length === 0 ? (
              <p className="muted">{t("noOwnedChannels")}</p>
            ) : (
              <ul className="profile-channel-list">
                {ownedChannels.map((channel) => (
                  <li key={channel.id}>
                    <img
                      className="avatar avatar--channel"
                      src={imageSource(channel.image_url)}
                      alt=""
                      onError={(event) => {
                        event.currentTarget.src = DEFAULT_AVATAR;
                      }}
                    />
                    <span className="profile-channel-list__copy">
                      <strong>#{channel.name}</strong>
                      <span>{channel.description || t("noDescription")}</span>
                    </span>
                    <button
                      type="button"
                      className="link-button"
                      aria-label={`${t("openChannel")} ${channel.name}`}
                      onClick={() => {
                        onClose();
                        navigate(`/channels/${channel.id}`);
                      }}
                    >
                      {t("open")}
                    </button>
                    <button
                      type="button"
                      className="icon-button profile-channel-list__manage"
                      aria-label={`${t("manageChannel")} ${channel.name}`}
                      title={t("manageChannel")}
                      onClick={() => setManagingChannel(channel)}
                    >
                      ⋯
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </section>
      </div>
      {managingChannel && (
        <ChannelSettingsDialog
          channel={managingChannel}
          onClose={() => setManagingChannel(null)}
          onUpdated={(updated) => {
            setOwnedChannels(
              (current) =>
                current?.map((item) =>
                  item.id === updated.id ? updated : item,
                ) ?? [],
            );
            setManagingChannel(updated);
          }}
          onDeleted={() => {
            setOwnedChannels(
              (current) =>
                current?.filter((item) => item.id !== managingChannel.id) ?? [],
            );
            setManagingChannel(null);
          }}
        />
      )}
    </>
  );
}
