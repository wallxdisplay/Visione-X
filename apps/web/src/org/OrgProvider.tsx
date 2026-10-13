import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  paths,
  type EntitlementsDoc,
  type MemberDoc,
  type OrgDoc,
  type OrgPermission,
  type UserMembership,
} from '@wallx-play/shared';
import { useAuth } from '../auth/AuthProvider';
import { useDoc } from '../lib/hooks';

const STORAGE_KEY = 'wxp.currentOrg';

interface OrgState {
  orgId: string;
  org: OrgDoc | undefined;
  member: MemberDoc | undefined;
  entitlements: EntitlementsDoc | undefined;
  loading: boolean;
  /** UI hint only — the server enforces every permission again. */
  can: (permission: OrgPermission) => boolean;
  /** Sites the member is limited to (empty = all sites). Lists of screens, sensors and alerts must filter by it. */
  siteScope: string[];
  activeOrgs: Array<[string, UserMembership]>;
  switchOrg: (orgId: string) => void;
}

const OrgContext = createContext<OrgState | null>(null);

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Picks the remembered org if it is still active, else the first active one. */
export function pickActiveOrg(memberships: Record<string, UserMembership> | undefined): string | null {
  const active = Object.entries(memberships ?? {}).filter(([, m]) => m.orgStatus === 'active');
  const stored = readStored();
  return active.find(([id]) => id === stored)?.[0] ?? active[0]?.[0] ?? null;
}

export function OrgProvider({ orgId: initialOrgId, children }: { orgId: string; children: ReactNode }) {
  const { user, profile } = useAuth();
  const [orgId, setOrgId] = useState(initialOrgId);

  const org = useDoc<OrgDoc>(paths.org(orgId));
  const member = useDoc<MemberDoc>(user ? paths.member(orgId, user.uid) : null);
  const entitlements = useDoc<EntitlementsDoc>(paths.orgEntitlements(orgId));

  const switchOrg = useCallback((id: string) => {
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* storage unavailable: selection lasts for this session only */
    }
    setOrgId(id);
  }, []);

  const value = useMemo<OrgState>(() => {
    const perms = new Set(member.data?.status === 'active' ? member.data.permissions : []);
    return {
      orgId,
      org: org.data,
      member: member.data,
      entitlements: entitlements.data,
      loading: org.loading || member.loading,
      can: (p) => perms.has(p),
      siteScope: member.data?.status === 'active' ? (member.data.siteScope ?? []) : [],
      activeOrgs: Object.entries(profile?.memberships ?? {}).filter(([, m]) => m.orgStatus === 'active'),
      switchOrg,
    };
  }, [orgId, org, member, entitlements.data, profile, switchOrg]);

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgState {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error('useOrg must be used inside OrgProvider');
  return ctx;
}
