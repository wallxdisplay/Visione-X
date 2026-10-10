import { Button, SelectField, TextAreaField, TextField } from '@visione-x/ui';
import { DEFAULT_TIMEZONE, INDIAN_STATES, OrgSignupDetails } from '@visione-x/shared';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { fieldErrors, timezoneOptions } from '../../lib/format';

type Values = Record<keyof OrgSignupDetails, string>;

const EMPTY: Values = {
  orgName: '',
  contactName: '',
  phone: '',
  city: '',
  stateCode: '27',
  expectedScreens: '',
  gstin: '',
  timezone: DEFAULT_TIMEZONE,
  notes: '',
};

export function toFormValues(details?: Partial<OrgSignupDetails>): Values {
  if (!details) return EMPTY;
  return Object.fromEntries(
    Object.entries({ ...EMPTY, ...details }).map(([k, v]) => [k, v === undefined ? '' : String(v)]),
  ) as Values;
}

export function OrgSignupForm({
  initial,
  submitLabel,
  busy,
  onSubmit,
  children,
}: {
  initial?: Values;
  submitLabel: string;
  busy: boolean;
  onSubmit: (details: OrgSignupDetails) => void;
  /** Extra fields rendered above the actions (e.g. a response to the reviewer). */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Values>(initial ?? EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const timezones = useMemo(timezoneOptions, []);
  const states = useMemo(() => INDIAN_STATES.map((s) => ({ value: s.code, label: s.name })), []);

  const set = (key: keyof Values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = OrgSignupDetails.safeParse({ ...values, notes: values.notes || undefined });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    onSubmit(parsed.data);
  }

  return (
    <form className="vx-form" onSubmit={submit} noValidate>
      <TextField label={t('onboarding.orgName')} required value={values.orgName} onChange={set('orgName')} error={errors.orgName} />
      <div className="vx-form__row">
        <TextField
          label={t('onboarding.contactName')}
          required
          autoComplete="name"
          value={values.contactName}
          onChange={set('contactName')}
          error={errors.contactName}
        />
        <TextField
          label={t('onboarding.phone')}
          required
          type="tel"
          autoComplete="tel"
          placeholder="+91 98200 12345"
          value={values.phone}
          onChange={set('phone')}
          error={errors.phone}
        />
      </div>
      <div className="vx-form__row">
        <TextField label={t('onboarding.city')} required value={values.city} onChange={set('city')} error={errors.city} />
        <SelectField
          label={t('onboarding.state')}
          required
          options={states}
          value={values.stateCode}
          onChange={set('stateCode')}
          error={errors.stateCode}
        />
      </div>
      <div className="vx-form__row">
        <TextField
          label={t('onboarding.expectedScreens')}
          required
          type="number"
          min={1}
          inputMode="numeric"
          value={values.expectedScreens}
          onChange={set('expectedScreens')}
          error={errors.expectedScreens}
        />
        <TextField
          label={t('onboarding.gstin')}
          hint={t('onboarding.gstinHint')}
          value={values.gstin}
          onChange={(e) => setValues((v) => ({ ...v, gstin: e.target.value.toUpperCase() }))}
          error={errors.gstin}
        />
      </div>
      <SelectField
        label={t('onboarding.timezone')}
        required
        options={timezones}
        value={values.timezone}
        onChange={set('timezone')}
        error={errors.timezone}
      />
      <TextAreaField
        label={t('onboarding.notes')}
        hint={t('onboarding.notesHint')}
        value={values.notes}
        onChange={set('notes')}
        error={errors.notes}
      />
      {children}
      <div className="vx-form__actions">
        <Button type="submit" variant="primary" disabled={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
