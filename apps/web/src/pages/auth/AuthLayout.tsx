import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
  return (
    <div className="standalone">
      <div className="auth">
        <div className="auth__brand">
          <span className="shell__logo" aria-hidden>
            X
          </span>
          <span>
            <strong>{t('product.name')}</strong> <small>{t('product.byline')}</small>
          </span>
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
