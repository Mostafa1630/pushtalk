import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { loginSchema, registerSchema, validateForm } from "../validation";
import {
  useLanguage,
  type TranslationKey,
  type TranslationValues,
} from "../i18n";

function errorText(
  err: unknown,
  t: (key: TranslationKey, values?: TranslationValues) => string,
): string {
  if (err instanceof ApiError) {
    const details = err.details as
      | { field: string; message: string }[]
      | undefined;
    if (
      err.code === "VALIDATION_ERROR" &&
      Array.isArray(details) &&
      details.length > 0
    ) {
      return details
        .map(
          (d) =>
            `${d.field === "username" ? t("username") : t("password")}: ${d.message.replace(/^Value error, /, "")}`,
        )
        .join(" · ");
    }
    if (err.code === "INVALID_CREDENTIALS") return t("invalidCredentials");
    if (err.code === "USERNAME_TAKEN") return t("usernameTaken");
    return err.message;
  }
  return t("somethingWentWrong");
}

export function LoginPage() {
  const { user, login, register } = useAuth();
  const { t } = useLanguage();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/channels" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const validationErrors = await validateForm(
      mode === "login" ? loginSchema : registerSchema,
      { username, password },
      t,
    );
    setFieldErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;
    setBusy(true);
    try {
      await (mode === "login"
        ? login(username, password)
        : register(username, password));
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={submit} noValidate>
        <header className="auth-intro">
          <img className="auth-logo" src="/images/logo.jpg" alt="PushTalk" />
          <h1>{t("welcome")}</h1>
          <p className="muted">
            {mode === "login"
              ? t("loginDescription")
              : t("registerDescription")}
          </p>
        </header>
        <div key={mode} className={`auth-content auth-content--${mode}`}>
          <label className={fieldErrors.username ? "field--invalid" : ""}>
            {t("username")}
            <input
              name="username"
              className={fieldErrors.username ? "input--invalid" : ""}
              aria-invalid={Boolean(fieldErrors.username)}
              autoComplete="username"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
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
          <label className={fieldErrors.password ? "field--invalid" : ""}>
            {t("password")}
            <input
              name="password"
              className={fieldErrors.password ? "input--invalid" : ""}
              aria-invalid={Boolean(fieldErrors.password)}
              type="password"
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setFieldErrors((current) => {
                  const next = { ...current };
                  delete next.password;
                  return next;
                });
              }}
              required
              minLength={8}
              maxLength={72}
            />
            {fieldErrors.password && (
              <span className="field-error" role="alert">
                {fieldErrors.password}
              </span>
            )}
          </label>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <button className="primary auth-submit" type="submit" disabled={busy}>
            {busy
              ? t("loading")
              : mode === "login"
                ? t("logIn")
                : t("register")}
          </button>
          <button
            type="button"
            className="link-button auth-switch"
            onClick={() => {
              setError(null);
              setMode(mode === "login" ? "register" : "login");
            }}
          >
            {mode === "login" ? t("createAccount") : t("backToLogin")}
          </button>
        </div>
      </form>
    </div>
  );
}
