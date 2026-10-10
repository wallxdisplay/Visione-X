import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'danger';

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      className={['vx-btn', `vx-btn--${variant}`, size === 'sm' && 'vx-btn--sm', className]
        .filter(Boolean)
        .join(' ')}
      {...props}
    />
  );
}

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** Status is always shown as text + color, never color alone. */
export function StatusChip({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <span className={`vx-chip vx-chip--${tone}`}>{children}</span>;
}

export function Card({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section className="vx-card">
      {title ? <h2 className="vx-card__title">{title}</h2> : null}
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="vx-page-header">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div>{actions}</div> : null}
    </header>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="vx-empty">
      {icon}
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}
