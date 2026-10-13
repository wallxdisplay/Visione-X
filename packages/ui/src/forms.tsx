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
    <div className="wxp-field">
      <label htmlFor={id} className="wxp-field__label">
        {label}
        {required ? <span className="wxp-field__req" aria-hidden> *</span> : null}
      </label>
      {children}
      {error ? (
        <p id={`${id}-err`} className="wxp-field__error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="wxp-field__hint">
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
        className="wxp-input"
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
        className="wxp-input wxp-input--area"
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
  SelectHTMLAttributes<HTMLSelectElement> & { options: Array<{ value: string; label: string; disabled?: boolean }> }) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error} required={required}>
      <select
        id={id}
        className="wxp-input"
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        {...select}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
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
    <div className={`wxp-alert wxp-alert--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {title ? <strong>{title}</strong> : null}
      {children ? <div>{children}</div> : null}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="wxp-spinner" role="status" aria-live="polite">
      <span className="wxp-spinner__dot" aria-hidden />
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
  size = 'md',
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
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
    <dialog ref={ref} className={`wxp-dialog wxp-dialog--${size}`} onClose={onClose} aria-labelledby={titleId}>
      <header className="wxp-dialog__header">
        <h2 id={titleId}>{title}</h2>
      </header>
      <div className="wxp-dialog__body">{children}</div>
      {footer ? <footer className="wxp-dialog__footer">{footer}</footer> : null}
    </dialog>
  );
}
