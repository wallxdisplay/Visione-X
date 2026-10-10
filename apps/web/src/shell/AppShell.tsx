import { HelpCircle, LogOut, Menu, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useOrg } from '../org/OrgProvider';
import { EmergencyBanner } from './EmergencyBanner';
import type { NavGroup } from './nav';
import { NotificationBell } from './NotificationBell';

function OrgSwitcher() {
  const { t } = useTranslation();
  const { orgId, org, activeOrgs, switchOrg } = useOrg();
  if (activeOrgs.length <= 1) return <span className="shell__org-name">{org?.name ?? '…'}</span>;
  return (
    <select
      className="vx-input shell__org-select"
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

export function AppShell({ nav, variant }: { nav: NavGroup[]; variant: 'customer' | 'admin' }) {
  const { t } = useTranslation();
  const { user, platformRole, signOut } = useAuth();
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className={`shell shell--${variant}`} data-nav-open={navOpen}>
      <aside className="shell__sidebar" aria-label={t('shell.navigation')}>
        <div className="shell__brand">
          <span className="shell__logo" aria-hidden>
            X
          </span>
          <span>
            <strong>{t('product.name')}</strong>
            <small>{t('product.byline')}</small>
          </span>
        </div>
        {variant === 'admin' ? <div className="shell__admin-badge">{t('shell.adminBadge')}</div> : null}
        <nav>
          {nav.map((group) => (
            <div className="shell__group" key={group.labelKey}>
              <div className="shell__group-label">{t(group.labelKey)}</div>
              {group.items.map(({ labelKey, path, icon: Icon }) => (
                <NavLink
                  key={path}
                  to={path}
                  end={path === '/' || path === '/admin'}
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
            {variant === 'customer' ? <OrgSwitcher /> : t(`platformRoles.${platformRole}`)}
          </div>
          <div className="shell__actions">
            {variant === 'customer' && platformRole ? (
              <Link to="/admin" className="vx-btn vx-btn--tertiary vx-btn--sm">
                <ShieldCheck size={16} aria-hidden /> {t('shell.adminBadge')}
              </Link>
            ) : null}
            {variant === 'admin' ? (
              <Link to="/" className="vx-btn vx-btn--tertiary vx-btn--sm">
                {t('shell.backToApp')}
              </Link>
            ) : null}
            {variant === 'customer' ? <NotificationBell /> : null}
            <button type="button" className="shell__icon-btn" aria-label={t('shell.help')}>
              <HelpCircle size={18} />
            </button>
            <span className="shell__user vx-muted" title={user?.email ?? ''}>
              {user?.email}
            </span>
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
        {variant === 'customer' ? <EmergencyBanner /> : null}
        <main className="shell__content">
          <Outlet />
        </main>
      </div>
      <div className="shell__scrim" onClick={() => setNavOpen(false)} aria-hidden />
    </div>
  );
}
