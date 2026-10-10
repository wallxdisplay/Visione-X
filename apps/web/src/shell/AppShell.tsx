import { Bell, HelpCircle, Menu, UserCircle2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';
import type { NavGroup } from './nav';

export function AppShell({ nav, variant }: { nav: NavGroup[]; variant: 'customer' | 'admin' }) {
  const { t } = useTranslation();
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className={`shell shell--${variant}`} data-nav-open={navOpen}>
      <aside className="shell__sidebar" aria-label={t('shell.toggleNav')}>
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
            {variant === 'customer' ? t('shell.orgPlaceholder') : t('shell.adminBadge')}
          </div>
          <div className="shell__actions">
            <button type="button" className="shell__icon-btn" aria-label={t('shell.notifications')}>
              <Bell size={18} />
            </button>
            <button type="button" className="shell__icon-btn" aria-label={t('shell.help')}>
              <HelpCircle size={18} />
            </button>
            <button type="button" className="shell__icon-btn" aria-label={t('shell.account')}>
              <UserCircle2 size={22} />
            </button>
          </div>
        </header>
        <main className="shell__content">
          <Outlet />
        </main>
      </div>
      <div className="shell__scrim" onClick={() => setNavOpen(false)} aria-hidden />
    </div>
  );
}
