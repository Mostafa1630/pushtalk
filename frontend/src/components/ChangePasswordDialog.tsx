import { useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useLanguage } from "../i18n";
import { passwordChangeSchema, validateForm } from "../validation";

const PASSWORD_ERROR_TRANSLATIONS = {
  CURRENT_PASSWORD_INVALID: "currentPasswordInvalid",
  PASSWORD_UNCHANGED: "passwordMustDiffer",
} as const;

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const { changePassword } = useAuth();
  const { t } = useLanguage();
  const [passwordValues, setPasswordValues] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [passwordErrors, setPasswordErrors] = useState<Record<string, string>>(
    {},
  );
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const savePassword = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setPasswordNotice(null);
    const validationErrors = await validateForm(
      passwordChangeSchema,
      passwordValues,
      t,
    );
    setPasswordErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;
    setBusy(true);
    try {
      await changePassword(
        passwordValues.currentPassword,
        passwordValues.newPassword,
      );
      setPasswordValues({
        currentPassword: "",
        newPassword: "",
        confirmPassword: "",
      });
      setPasswordErrors({});
      setPasswordNotice(t("passwordChanged"));
    } catch (err) {
      setError(
        err instanceof ApiError
          ? PASSWORD_ERROR_TRANSLATIONS[
              err.code as keyof typeof PASSWORD_ERROR_TRANSLATIONS
            ]
            ? t(
                PASSWORD_ERROR_TRANSLATIONS[
                  err.code as keyof typeof PASSWORD_ERROR_TRANSLATIONS
                ],
              )
            : err.message
          : t("passwordChangeError"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="modal change-password-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="change-password-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="change-password-title">{t("changePassword")}</h2>
        <form
          className="change-password-form"
          onSubmit={savePassword}
          noValidate
        >
          {(
            [
              ["currentPassword", "currentPassword"],
              ["newPassword", "newPassword"],
              ["confirmPassword", "confirmNewPassword"],
            ] as const
          ).map(([field, label]) => (
            <label
              className={`profile-name-field${passwordErrors[field] ? " field--invalid" : ""}`}
              key={field}
            >
              {t(label)}
              <input
                type="password"
                autoComplete={
                  field === "currentPassword"
                    ? "current-password"
                    : "new-password"
                }
                className={passwordErrors[field] ? "input--invalid" : ""}
                aria-invalid={Boolean(passwordErrors[field])}
                value={passwordValues[field]}
                onChange={(event) => {
                  setPasswordValues((current) => ({
                    ...current,
                    [field]: event.target.value,
                  }));
                  setPasswordErrors((current) => {
                    const next = { ...current };
                    delete next[field];
                    if (field === "newPassword") delete next.confirmPassword;
                    return next;
                  });
                }}
              />
              {passwordErrors[field] && (
                <span className="field-error" role="alert">
                  {passwordErrors[field]}
                </span>
              )}
            </label>
          ))}
          {passwordNotice && (
            <p className="success-text" role="status">
              {passwordNotice}
            </p>
          )}
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
              {busy ? t("loading") : t("updatePassword")}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
