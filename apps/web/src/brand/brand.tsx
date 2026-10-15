import { doc, getDoc } from 'firebase/firestore';
import { brandPalette, paths, type BrandDomainDoc, type BrandPublic } from '@wallx-play/shared';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { db } from '../lib/firebase';
import './brand.css';

/**
 * White label in the web app. A custom web address (brandDomains/{hostname}) brands the whole
 * app, including sign-in; inside an organization its effective brand applies, and in the
 * partner portal the reseller's. `useApplyBrand` sets colours, title and favicon.
 */

/** Our own addresses: no brand lookup. */
const OWN_HOSTS = ['wallx-play.web.app', 'wallx-play.firebaseapp.com', 'localhost', '127.0.0.1'];

const DomainBrandContext = createContext<BrandPublic | null>(null);

/** Looks up the brand of a custom web address once (public, before sign-in). */
export function DomainBrandProvider({ children }: { children: ReactNode }) {
  const [brand, setBrand] = useState<BrandPublic | null>(null);
  useEffect(() => {
    const host = window.location.hostname.toLowerCase();
    if (OWN_HOSTS.includes(host)) return;
    getDoc(doc(db, paths.brandDomain(host)))
      .then((s) => setBrand((s.data() as BrandDomainDoc | undefined)?.brand ?? null))
      .catch(() => setBrand(null));
  }, []);
  return <DomainBrandContext.Provider value={brand}>{children}</DomainBrandContext.Provider>;
}

export const useDomainBrand = () => useContext(DomainBrandContext);

const VARS = ['--color-primary', '--color-primary-hover', '--color-primary-pressed', '--color-primary-soft'] as const;
const DEFAULT_TITLE = 'WallX Play';

function setFavicon(href: string | null) {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = href ? (href.match(/^data:([^;]+)/)?.[1] ?? 'image/png') : 'image/svg+xml';
  link.href = href ?? '/favicon.svg';
}

/** Applies a brand's colours, name (tab title) and logo (favicon); WallX Play when null. */
export function useApplyBrand(brand: BrandPublic | null) {
  const key = brand ? `${brand.name}|${brand.primaryColor}|${brand.updatedAt}` : '';
  useEffect(() => {
    const root = document.documentElement.style;
    if (brand) {
      const p = brandPalette(brand.primaryColor);
      root.setProperty('--color-primary', p.primary);
      root.setProperty('--color-primary-hover', p.hover);
      root.setProperty('--color-primary-pressed', p.pressed);
      root.setProperty('--color-primary-soft', p.soft);
      document.title = brand.name;
      setFavicon(brand.logo);
    }
    return () => {
      VARS.forEach((v) => root.removeProperty(v));
      document.title = DEFAULT_TITLE;
      setFavicon(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-applied when the brand changes (key)
  }, [key]);
}

/** Sidebar / sign-in mark: the brand's logo and name, or WallX Play's. */
export function BrandMark({ brand, variant = 'shell' }: { brand: BrandPublic | null; variant?: 'shell' | 'auth' }) {
  const { t } = useTranslation();
  return (
    <>
      {brand?.logo ? (
        <img className="shell__logo shell__logo--image" src={brand.logo} alt="" />
      ) : (
        <span className="shell__logo" aria-hidden>
          {brand ? brand.name.slice(0, 1).toUpperCase() : 'X'}
        </span>
      )}
      <span>
        <strong>{brand?.name ?? t('product.name')}</strong>
        {variant === 'auth' ? ' ' : null}
        <small>{brand ? t('brand.poweredBy') : t('product.byline')}</small>
      </span>
    </>
  );
}
