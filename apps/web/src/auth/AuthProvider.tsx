import { onAuthStateChanged, signOut as fbSignOut, type User } from 'firebase/auth';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { PLATFORM_ROLES, paths, type PlatformRole, type UserProfileDoc } from '@visione-x/shared';
import { auth } from '../lib/firebase';
import { useDoc } from '../lib/hooks';

interface AuthState {
  user: User | null;
  /** True until the first auth state and claims are known. */
  loading: boolean;
  platformRole: PlatformRole | null;
  profile: UserProfileDoc | undefined;
  profileLoading: boolean;
  /** Re-reads the user (e.g. after email verification) and refreshes claims. */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [platformRole, setPlatformRole] = useState<PlatformRole | null>(null);
  const [loading, setLoading] = useState(true);
  const [, setVersion] = useState(0);

  const readClaims = useCallback(async (u: User | null, force = false) => {
    if (!u) {
      setPlatformRole(null);
      return;
    }
    const token = await u.getIdTokenResult(force);
    const role = token.claims.platformRole as PlatformRole | undefined;
    setPlatformRole(role && PLATFORM_ROLES.includes(role) ? role : null);
  }, []);

  useEffect(
    () =>
      onAuthStateChanged(auth, async (u) => {
        setUser(u);
        await readClaims(u).catch(() => setPlatformRole(null));
        setLoading(false);
      }),
    [readClaims],
  );

  const profile = useDoc<UserProfileDoc>(user ? paths.userProfile(user.uid) : null);

  const refresh = useCallback(async () => {
    const u = auth.currentUser;
    if (!u) return;
    await u.reload();
    await readClaims(u, true);
    setUser(auth.currentUser);
    setVersion((v) => v + 1); // User is mutated in place by reload(); force a re-render.
  }, [readClaims]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      platformRole,
      profile: profile.data,
      profileLoading: profile.loading,
      refresh,
      signOut: () => fbSignOut(auth),
    }),
    [user, loading, platformRole, profile.data, profile.loading, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
