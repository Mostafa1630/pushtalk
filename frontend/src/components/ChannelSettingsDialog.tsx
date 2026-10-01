import { useEffect, useState, type FormEvent } from "react";
import { API_BASE } from "../api/client";
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

interface Props {
  channel: Channel;
  onClose: () => void;
  onUpdated: (channel: Channel) => void;
  onDeleted: () => void;
}

export function ChannelSettingsDialog({
  channel,
  onClose,
  onUpdated,
  onDeleted,
}: Props) {
  const { t } = useLanguage();
  const [name, setName] = useState(channel.name);
  const [description, setDescription] = useState(channel.description);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

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
    const validationErrors = await validateForm(
      channelSchema,
      { name, description },
      t,
    );
    setFieldErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;
    setBusy(true);
    try {
      let updated = await channelApi.update(
        channel.id,
        name.trim(),
        description.trim(),
      );
      onUpdated(updated);
      if (photo) {
        updated = await channelApi.uploadImage(channel.id, photo);
        onUpdated({
          ...updated,
          image_url: updated.image_url
            ? `${updated.image_url}?v=${Date.now()}`
            : null,
        });
      }
      onClose();
    } catch {
      setError(t("channelSaveError"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setError(null);
    setBusy(true);
    try {
      await channelApi.delete(channel.id);
      onDeleted();
    } catch {
      setError(t("channelDeleteError"));
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="modal channel-settings"
        role={confirmDelete ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby="channel-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {confirmDelete ? (
          <>
            <h2 id="channel-settings-title">{t("confirmDeleteChannel")}</h2>
            <p className="muted">
              {t("confirmDeleteChannelBody", { name: channel.name })}
            </p>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={busy}
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => void remove()}
                disabled={busy}
              >
                {busy ? t("loading") : t("deleteChannel")}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="channel-settings-title">{t("channelSettings")}</h2>
            <form onSubmit={save} noValidate>
              <label className="channel-settings__photo">
                <img
                  className="avatar avatar--channel-settings"
                  src={preview ?? imageSource(channel.image_url)}
                  alt={t("channelPhotoAlt")}
                  onError={(event) => {
                    event.currentTarget.src = DEFAULT_CHANNEL_IMAGE;
                  }}
                />
                <span>{t("changePhoto")}</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(event) =>
                    setPhoto(event.target.files?.[0] ?? null)
                  }
                />
              </label>
              <label
                className={`profile-name-field${fieldErrors.name ? " field--invalid" : ""}`}
              >
                {t("channelName")}
                <input
                  value={name}
                  className={fieldErrors.name ? "input--invalid" : ""}
                  aria-invalid={Boolean(fieldErrors.name)}
                  onChange={(event) => {
                    setName(event.target.value);
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
              <label
                className={`profile-name-field${fieldErrors.description ? " field--invalid" : ""}`}
              >
                {t("channelDescription")}
                <textarea
                  className={
                    fieldErrors.description
                      ? "channel-description-input input--invalid"
                      : "channel-description-input"
                  }
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
                  rows={3}
                />
                {fieldErrors.description && (
                  <span className="field-error" role="alert">
                    {fieldErrors.description}
                  </span>
                )}
              </label>
              {error && (
                <div className="error" role="alert">
                  {error}
                </div>
              )}
              <div className="modal-actions channel-settings__actions">
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => setConfirmDelete(true)}
                >
                  {t("deleteChannel")}
                </button>
                <span />
                <button type="button" onClick={onClose}>
                  {t("cancel")}
                </button>
                <button className="primary" type="submit" disabled={busy}>
                  {busy ? t("loading") : t("saveChanges")}
                </button>
              </div>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
