import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, Outlet } from 'react-router';
import { paths, publicBrand, type AccountDoc, type AccountRole, type BrandPublic, type PartnerOverview, type UserAccountMembership } from '@wallx-play/shared';
import { useDoc } from '../lib/hooks';
import { useAuth } from '../auth/AuthProvider';
import { call, errorMessage } from '../lib/api';
import { FullPageSpinner } from '../auth/guards';

const STORAGE_KEY = 'wxp.currentAccount';

interface PartnerState {
  accountId: string;
  name: string;
  role: AccountRole;
  /** Reseller accounts whose portal the user can open. */
  accounts: Array<[string, UserAccountMembership]>;
  switchAccount: (accountId: string) => void;
  /** Customers, plans with dealer prices and the account's billing (partnerOverview). */
  overview: PartnerOverview | null;
  overviewError: string | null;
  refresh: () => Promise<void>;
  /** White label: the reseller's brand for the portal (null: WallX Play). */
  brand: BrandPublic | null;
}

const PartnerContext = createContext<PartnerState | null>(null);

/** Reseller accounts the user may open (active, portal on). */
export function openAccounts(accounts: Record<string, UserAccountMembership> | undefined): Array<[string, UserAccountMembership]> {
  return Object.entries(accounts ?? {})
    .filter(([, a]) => a.status === 'active' && a.portal)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name));
}

function stored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** /partner: opens the remembered (or first) reseller account, or goes back to the app. */
export function PartnerGate() {
  const { profile, profileLoading } = useAuth();
  if (profileLoading) return <FullPageSpinner />;
  const accounts = openAccounts(profile?.accounts);
  if (!accounts.length) return <Navigate to="/" replace />;
  const accountId = accounts.find(([id]) => id === stored())?.[0] ?? accounts[0]![0];
  return (
    <PartnerProvider initialId={accountId} accounts={accounts}>
      <Outlet />
    </PartnerProvider>
  );
}

function PartnerProvider({ initialId, accounts, children }: { initialId: string; accounts: Array<[string, UserAccountMembership]>; children: ReactNode }) {
  const [accountId, setAccountId] = useState(initialId);
  const [overview, setOverview] = useState<PartnerOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const entry = accounts.find(([id]) => id === accountId)?.[1] ?? accounts[0]![1];
  const account = useDoc<AccountDoc>(paths.account(accountId));
  const brand = account.data?.whiteLabel && account.data.brand ? publicBrand(account.data.brand) : null;

  const refresh = useCallback(async () => {
    try {
      setOverview(await call<PartnerOverview>('partnerOverview', { accountId }));
      setOverviewError(null);
    } catch (err) {
      setOverviewError(errorMessage(err));
    }
  }, [accountId]);

  useEffect(() => {
    setOverview(null);
    void refresh();
  }, [refresh]);

  const switchAccount = useCallback((id: string) => {
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* storage unavailable */
    }
    setAccountId(id);
  }, []);

  const value = useMemo<PartnerState>(
    () => ({ accountId, name: entry.name, role: entry.role, accounts, switchAccount, overview, overviewError, refresh, brand }),
    [accountId, entry, accounts, switchAccount, overview, overviewError, refresh, brand],
  );
  return <PartnerContext.Provider value={value}>{children}</PartnerContext.Provider>;
}

export function usePartner(): PartnerState {
  const ctx = useContext(PartnerContext);
  if (!ctx) throw new Error('usePartner must be used inside PartnerGate');
  return ctx;
}
