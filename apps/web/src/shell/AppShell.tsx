import { Briefcase, HelpCircle, KeyRound, LogOut, Menu, ShieldCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { SECURITY_PATH } from '../auth/mfa';
import { useOrg } from '../org/OrgProvider';
import { openAccounts, usePartner } from '../partner/PartnerProvider';
import { effectiveBrand, type BrandPublic } from '@wallx-play/shared';
import { BrandMark, useApplyBrand, useDomainBrand } from '../brand/brand';
import { BillingBanner } from './BillingBanner';
import { EmergencyBanner } from './EmergencyBanner';
import { LanguagePicker } from './LanguagePicker';
import { PlatformNotice } from './PlatformNotice';
import { SupportSessionBanner } from './SupportSessionBanner';
import type { NavGroup } from './nav';
import { NotificationBell } from './NotificationBell';

function OrgSwitcher() {
  const { t } = useTranslation();
  const { orgId, org, activeOrgs, switchOrg } = useOrg();
  if (activeOrgs.length <= 1) return <span className="shell__org-name">{org?.name ?? '…'}</span>;
  return (
    <select
      className="wxp-input shell__org-select"
      aria-label={t('shell.switchOrg')}
      value={orgId}
      onChange={(e) => switchOrg(e.target.value)}
    >
      {activeOrgs.map(([id, m]) => (
        <option key={id} value={id}>
          {m.orgName}
        </option>
      ))}
    </select>
  );
}

function AccountSwitcher() {
  const { t } = useTranslation();
  const { accountId, name, accounts, switchAccount } = usePartner();
  if (accounts.length <= 1) return <span className="shell__org-name">{name}</span>;
  return (
    <select className="wxp-input shell__org-select" aria-label={t('shell.switchAccount')} value={accountId} onChange={(e) => switchAccount(e.target.value)}>
      {accounts.map(([id, a]) => (
        <option key={id} value={id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}

/** The organization's brand (its own, else its reseller's). */
function CustomerBrand({ children }: { children: (brand: BrandPublic | null) => ReactNode }) {
  const { org, entitlements } = useOrg();
  const domain = useDomainBrand();
  return <>{children((org ? effectiveBrand(org, entitlements) : null) ?? domain)}</>;
}

function PartnerBrand({ children }: { children: (brand: BrandPublic | null) => ReactNode }) {
  const { brand } = usePartner();
  const domain = useDomainBrand();
  return <>{children(brand ?? domain)}</>;
}

export function AppShell(props: { nav: NavGroup[]; variant: 'customer' | 'admin' | 'partner' }) {
  // White label: customers see their organization's brand, resellers theirs; Super Admin never.
  if (props.variant === 'customer') return <CustomerBrand>{(brand) => <Shell {...props} brand={brand} />}</CustomerBrand>;
  if (props.variant === 'partner') return <PartnerBrand>{(brand) => <Shell {...props} brand={brand} />}</PartnerBrand>;
  return <Shell {...props} brand={null} />;
}

function Shell({ nav, variant, brand }: { nav: NavGroup[]; variant: 'customer' | 'admin' | 'partner'; brand: BrandPublic | null }) {
  useApplyBrand(brand);
  const { t } = useTranslation();
  const { user, platformRole, profile, signOut } = useAuth();
  const partnerPortal = openAccounts(profile?.accounts).length > 0;
  const hasOrgs = Object.values(profile?.memberships ?? {}).some((m) => m.orgStatus === 'active');
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className={`shell shell--${variant}`} data-nav-open={navOpen}>
      <aside className="shell__sidebar" aria-label={t('shell.navigation')}>
        <div className="shell__brand">
          <BrandMark brand={brand} />
        </div>
        {variant === 'admin' ? <div className="shell__admin-badge">{t('shell.adminBadge')}</div> : null}
        {variant === 'partner' ? <div className="shell__admin-badge shell__partner-badge">{t('shell.partnerBadge')}</div> : null}
        <nav>
          {nav.map((group) => (
            <div className="shell__group" key={group.labelKey}>
              <div className="shell__group-label">{t(group.labelKey)}</div>
              {group.items.map(({ labelKey, path, icon: Icon }) => (
                <NavLink
                  key={path}
                  to={path}
                  end={path === '/' || path === '/admin' || path === '/partner'}
                  className="shell__link"
                  onClick={() => setNavOpen(false)}
                >
                  <Icon size={20} aria-hidden />
                  <span>{t(labelKey)}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <div className="shell__main">
        <header className="shell__topbar">
          <button
            type="button"
            className="shell__icon-btn shell__menu-btn"
            aria-label={t('shell.toggleNav')}
            onClick={() => setNavOpen((open) => !open)}
          >
            <Menu size={20} />
          </button>
          <div className="shell__context">
            {variant === 'customer' ? <OrgSwitcher /> : variant === 'partner' ? <AccountSwitcher /> : t(`platformRoles.${platformRole}`)}
          </div>
          <div className="shell__actions">
            {variant === 'customer' && platformRole ? (
              <Link to="/admin" className="wxp-btn wxp-btn--tertiary wxp-btn--sm">
                <ShieldCheck size={16} aria-hidden /> {t('shell.adminBadge')}
              </Link>
            ) : null}
            {variant === 'customer' && partnerPortal ? (
              <Link to="/partner" className="wxp-btn wxp-btn--tertiary wxp-btn--sm">
                <Briefcase size={16} aria-hidden /> {t('shell.partnerBadge')}
              </Link>
            ) : null}
            {variant === 'admin' || (variant === 'partner' && hasOrgs) ? (
              <Link to="/" className="wxp-btn wxp-btn--tertiary wxp-btn--sm">
                {t('shell.backToApp')}
              </Link>
            ) : null}
            {variant === 'customer' ? <NotificationBell /> : null}
            <LanguagePicker />
            {variant === 'customer' ? (
              <Link to="/help" className="shell__icon-btn" aria-label={t('shell.help')} title={t('shell.help')}>
                <HelpCircle size={18} />
              </Link>
            ) : null}
            <span className="shell__user wxp-muted" title={user?.email ?? ''}>
              {user?.email}
            </span>
            <Link to={SECURITY_PATH} className="shell__icon-btn" aria-label={t('shell.security')} title={t('shell.security')}>
              <KeyRound size={18} />
            </Link>
            <button
              type="button"
              className="shell__icon-btn"
              aria-label={t('shell.signOut')}
              title={t('shell.signOut')}
              onClick={() => void signOut()}
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>
        <PlatformNotice />
        {variant === 'customer' ? <SupportSessionBanner /> : null}
        {variant === 'customer' ? <EmergencyBanner /> : null}
        {variant === 'customer' ? <BillingBanner /> : null}
        <main className="shell__content">
          <Outlet />
        </main>
      </div>
      <div className="shell__scrim" onClick={() => setNavOpen(false)} aria-hidden />
    </div>
  );
}
