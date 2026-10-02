import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useNavigate,
} from "react-router-dom";
import { API_BASE } from "./api/client";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { LanguageProvider, useLanguage } from "./i18n";
import { ScrollToTopButton } from "./components/ScrollToTopButton";

const ProfileDialog = lazy(() =>
  import("./components/ProfileDialog").then((module) => ({
    default: module.ProfileDialog,
  })),
);
const ChangePasswordDialog = lazy(() =>
  import("./components/ChangePasswordDialog").then((module) => ({
    default: module.ChangePasswordDialog,
  })),
);
const ChannelPage = lazy(() =>
  import("./pages/ChannelPage").then((module) => ({
    default: module.ChannelPage,
  })),
);
const ChannelsPage = lazy(() =>
  import("./pages/ChannelsPage").then((module) => ({
    default: module.ChannelsPage,
  })),
);
const LoginPage = lazy(() =>
  import("./pages/LoginPage").then((module) => ({
    default: module.LoginPage,
  })),
);

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, checking } = useAuth();
  const { t } = useLanguage();
  if (checking) return <p className="muted center">{t("loading")}</p>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function TopBar() {
  const { user, logout } = useAuth();
  const { language, setLanguage, t } = useLanguage();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [logoutNotice, setLogoutNotice] = useState(false);

  const avatarSource = user?.avatar_url
    ? `${API_BASE}${user.avatar_url.replace(/^\/api/, "")}`
    : "/images/avatar-placeholder.jpg";

  const confirmLogout = () => {
    logout();
    setLogoutConfirmOpen(false);
    setLogoutNotice(true);
    navigate("/login", { replace: true });
  };

  return (
    <header className="topbar">
      <span className="brand">{t("appName")}</span>
      <div className="topbar__actions">
        {user && (
          <div className="profile-menu-wrap">
            <button
              type="button"
              className="profile-trigger"
              aria-label={t("profile")}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <img
                className="avatar"
                src={avatarSource}
                alt=""
                onError={(event) => {
                  event.currentTarget.src = "/images/avatar-placeholder.jpg";
                }}
              />
            </button>
            {menuOpen && (
              <div className="profile-menu">
                <strong data-testid="me">{user.username}</strong>
                <button
                  type="button"
                  onClick={() => {
                    setProfileOpen(true);
                    setMenuOpen(false);
                  }}
                >
                  {t("profile")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setChangePasswordOpen(true);
                    setMenuOpen(false);
                  }}
                >
                  {t("changePassword")}
                </button>
                <button
                  type="button"
                  className="profile-menu__logout"
                  onClick={() => {
                    setLogoutConfirmOpen(true);
                    setMenuOpen(false);
                  }}
                >
                  {t("logout")}
                </button>
              </div>
            )}
          </div>
        )}
        <div className="language-toggle" role="group" aria-label="Language">
          <button
            type="button"
            className={language === "ar" ? "language-toggle__active" : ""}
            aria-pressed={language === "ar"}
            onClick={() => setLanguage("ar")}
          >
            AR
          </button>
          <button
            type="button"
            className={language === "en" ? "language-toggle__active" : ""}
            aria-pressed={language === "en"}
            onClick={() => setLanguage("en")}
          >
            EN
          </button>
        </div>
      </div>
      {profileOpen && (
        <Suspense fallback={null}>
          <ProfileDialog onClose={() => setProfileOpen(false)} />
        </Suspense>
      )}
      {changePasswordOpen && (
        <Suspense fallback={null}>
          <ChangePasswordDialog
            onClose={() => setChangePasswordOpen(false)}
          />
        </Suspense>
      )}
      {logoutConfirmOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={() => setLogoutConfirmOpen(false)}
        >
          <section
            className="modal logout-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="logout-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="logout-title">{t("confirmLogoutTitle")}</h2>
            <p className="muted">{t("confirmLogoutBody")}</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setLogoutConfirmOpen(false)}>
                {t("logoutCancel")}
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={confirmLogout}
              >
                {t("confirm")}
              </button>
            </div>
          </section>
        </div>
      )}
      {logoutNotice && (
        <div className="toast" role="status">
          <span>{t("logoutSuccess")}</span>
          <button
            type="button"
            aria-label={t("cancel")}
            onClick={() => setLogoutNotice(false)}
          >
            ×
          </button>
        </div>
      )}
    </header>
  );
}

function AppRoutes() {
  const { language, t } = useLanguage();
  const previousLanguage = useRef(language);
  const [localeMotion, setLocaleMotion] = useState(false);

  useEffect(() => {
    if (previousLanguage.current === language) return;
    previousLanguage.current = language;
    setLocaleMotion(true);
    const timer = window.setTimeout(() => setLocaleMotion(false), 220);
    return () => window.clearTimeout(timer);
  }, [language]);

  return (
    <div
      className={`app-shell${localeMotion ? " app-shell--locale-change" : ""}`}
    >
      <TopBar />
      <Suspense fallback={<p className="muted center">{t("loading")}</p>}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/channels"
            element={
              <RequireAuth>
                <ChannelsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/channels/:channelId"
            element={
              <RequireAuth>
                <ChannelPage />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/channels" replace />} />
        </Routes>
      </Suspense>
      <ScrollToTopButton />
    </div>
  );
}

export function App() {
  return (
    <LanguageProvider>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </LanguageProvider>
  );
}
