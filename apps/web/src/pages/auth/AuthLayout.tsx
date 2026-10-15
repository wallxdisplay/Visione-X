import type { ReactNode } from 'react';
import { BrandMark, useApplyBrand, useDomainBrand } from '../../brand/brand';

export function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  // A custom web address shows its brand before sign-in.
  const brand = useDomainBrand();
  useApplyBrand(brand);
  return (
    <div className="standalone">
      <div className="auth">
        <div className="auth__brand">
          <BrandMark brand={brand} variant="auth" />
        </div>
        <section className="standalone__panel">
          <h1 className="auth__title">{title}</h1>
          {description ? <p className="auth__desc">{description}</p> : null}
          {children}
        </section>
        {footer ? <div className="auth__footer">{footer}</div> : null}
      </div>
    </div>
  );
}
