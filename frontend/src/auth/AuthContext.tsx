import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { configureApiAuth } from "../api/client";
import { authApi } from "../api/endpoints";
import type { TokenResponse, User } from "../api/types";

const STORAGE_KEY = "pushtalk.session";

interface StoredSession {
  token: string;
  user: User;
}

interface AuthState {
  user: User | null;
  token: string | null;
  checking: boolean; // validating a stored token on startup
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  updateProfile: (username: string) => Promise<void>;
  updateAvatar: (file: File) => Promise<void>;
  changePassword: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

function readStored(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StoredSession | null>(readStored);
  const [checking, setChecking] = useState<boolean>(
    () => readStored() !== null,
  );
  const tokenRef = useRef<string | null>(session?.token ?? null);
  tokenRef.current = session?.token ?? null;

  const logout = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable: nothing to clear */
    }
    setSession(null);
  }, []);

  // Every API call reads the live token; a 401 from the server logs out.
  configureApiAuth(() => tokenRef.current, logout);

  const accept = useCallback((res: TokenResponse) => {
    const next = { token: res.access_token, user: res.user };
    tokenRef.current = next.token;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* private mode: session lives only in memory */
    }
    setSession(next);
  }, []);

  const updateUser = useCallback((user: User) => {
    setSession((current) => {
      if (!current) return current;
      const next = { ...current, user };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* private mode: session lives only in memory */
      }
      return next;
    });
  }, []);

  // Validate a stored token once on startup (it may have expired).
  useEffect(() => {
    if (!tokenRef.current) return;
    authApi
      .me()
      .catch(() => undefined) // 401 already triggered logout via the handler
      .finally(() => setChecking(false));
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user: session?.user ?? null,
      token: session?.token ?? null,
      checking,
      login: async (u, p) => accept(await authApi.login(u, p)),
      register: async (u, p) => accept(await authApi.register(u, p)),
      updateProfile: async (username) =>
        updateUser(await authApi.updateProfile(username)),
      updateAvatar: async (file) =>
        updateUser(await authApi.uploadAvatar(file)),
      changePassword: authApi.changePassword,
      logout,
    }),
    [session, checking, accept, logout, updateUser],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
