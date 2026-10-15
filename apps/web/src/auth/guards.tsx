import { Spinner } from '@wallx-play/ui';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Outlet, useLocation } from 'react-router';
import { OrgProvider, pickActiveOrg } from '../org/OrgProvider';
import { openAccounts } from '../partner/PartnerProvider';
import { NotAuthorized } from '../pages/NotAuthorized';
import { useAuth } from './AuthProvider';
import { SECURITY_PATH, staffMfaRequired } from './mfa';

// Guards decide what to SHOW. They are not security: Firestore rules and Cloud Functions
// enforce every permission on the server.

export function FullPageSpinner() {
  const { t } = useTranslation();
  return (
    <div className="standalone">
      <Spinner label={t('common.loading')} />
    </div>
  );
}

function nextParam(pathname: string, search: string) {
  return `?next=${encodeURIComponent(pathname + search)}`;
}

/** Signed in AND email verified. */
export function RequireUser({ children }: { children?: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to={`/signin${nextParam(location.pathname, location.search)}`} replace />;
  if (!user.emailVerified) {
    return <Navigate to={`/verify-email${nextParam(location.pathname, location.search)}`} replace />;
  }
  return children ?? <Outlet />;
}

/** WallX staff without a second factor in this session set one up (or sign in with it) first. */
export function RequireStaffSecondFactor() {
  const { platformRole, secondFactor } = useAuth();
  const location = useLocation();
  if (staffMfaRequired && platformRole && !secondFactor) {
    return <Navigate to={`${SECURITY_PATH}${nextParam(location.pathname, location.search)}`} replace />;
  }
  return <Outlet />;
}

export function RequirePlatformStaff() {
  const { platformRole } = useAuth();
  return platformRole ? <Outlet /> : <NotAuthorized />;
}

/** Customer area: needs an active org; otherwise the user goes to onboarding. */
export function CustomerGate() {
  const { profile, profileLoading, platformRole } = useAuth();
  if (profileLoading) return <FullPageSpinner />;
  const orgId = pickActiveOrg(profile?.memberships);
  // WallX staff usually have no customer org (Super Admin); reseller staff go to their portal.
  if (!orgId) return <Navigate to={platformRole ? '/admin' : openAccounts(profile?.accounts).length ? '/partner' : '/onboarding'} replace />;
  return (
    <OrgProvider key={orgId} orgId={orgId}>
      <Outlet />
    </OrgProvider>
  );
}

/** Auth pages: a signed-in, verified user goes straight to where they were heading. */
export function RedirectIfSignedIn({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <FullPageSpinner />;
  if (user) {
    const next = new URLSearchParams(location.search).get('next');
    return user.emailVerified ? (
      <Navigate to={safeNext(next)} replace />
    ) : (
      <Navigate to={`/verify-email${next ? `?next=${encodeURIComponent(safeNext(next))}` : ''}`} replace />
    );
  }
  return children;
}

/** Only allow same-site relative redirects. */
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}
