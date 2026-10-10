import {
  useEffect,
  useId,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

interface FieldShell {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  required?: boolean;
}

function Shell({
  id,
  label,
  hint,
  error,
  required,
  children,
}: FieldShell & { id: string; children: ReactNode }) {
  return (
    <div className="vx-field">
      <label htmlFor={id} className="vx-field__label">
        {label}
        {required ? <span className="vx-field__req" aria-hidden> *</span> : null}
      </label>
      {children}
      {error ? (
        <p id={`${id}-err`} className="vx-field__error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="vx-field__hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, error?: string, hint?: ReactNode) {
  return error ? `${id}-err` : hint ? `${id}-hint` : undefined;
}

export function TextField({
  label,
  hint,
  error,
  required,
  ...input
}: FieldShell & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error} required={required}>
      <input
        id={id}
        className="vx-input"
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        {...input}
      />
    </Shell>
  );
}

export function TextAreaField({
  label,
  hint,
  error,
  required,
  ...input
}: FieldShell & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error} required={required}>
      <textarea
        id={id}
        className="vx-input vx-input--area"
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        {...input}
      />
    </Shell>
  );
}

export function SelectField({
  label,
  hint,
  error,
  required,
  options,
  ...select
}: FieldShell &
  SelectHTMLAttributes<HTMLSelectElement> & { options: Array<{ value: string; label: string }> }) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error} required={required}>
      <select
        id={id}
        className="vx-input"
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        {...select}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Shell>
  );
}

export function Alert({
  tone,
  title,
  children,
}: {
  tone: 'info' | 'success' | 'warning' | 'danger';
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`vx-alert vx-alert--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {title ? <strong>{title}</strong> : null}
      {children ? <div>{children}</div> : null}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="vx-spinner" role="status" aria-live="polite">
      <span className="vx-spinner__dot" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

/** Native <dialog> for focus trapping and Escape handling. */
export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog ref={ref} className="vx-dialog" onClose={onClose} aria-labelledby={titleId}>
      <header className="vx-dialog__header">
        <h2 id={titleId}>{title}</h2>
      </header>
      <div className="vx-dialog__body">{children}</div>
      {footer ? <footer className="vx-dialog__footer">{footer}</footer> : null}
    </dialog>
  );
}
