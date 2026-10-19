import { Alert, Button, PageHeader, SelectField, Spinner, TextAreaField, TextField } from '@wallx-play/ui';
import { EMPTY_SUPPORT_CONTACTS, hasPlatformPermission, type PlatformBanner, type SupportContacts } from '@wallx-play/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth/AuthProvider';
import { call, errorMessage } from '../../lib/api';
import { usePlatformSettings } from '../../lib/platformSettings';
import './admin.css';
import { DEFAULT_GST_RATE_BPS, INDIAN_STATES, type OnlinePaymentSettings } from '@wallx-play/shared';
import { usePlans } from '../../content/billing';

/** "2026-10-20T18:00" in the browser's time zone ↔ epoch ms. */
const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

/** Super Admin → Platform settings: support contacts, notice banner, signups switch. */
export function AdminSettings() {
  const { t } = useTranslation();
  const { platformRole } = useAuth();
  const canEdit = hasPlatformPermission(platformRole, 'settings.edit');
  const settings = usePlatformSettings();
  const [support, setSupport] = useState<SupportContacts>(EMPTY_SUPPORT_CONTACTS);
  const [bannerOn, setBannerOn] = useState(false);
  const [banner, setBanner] = useState<{ message: string; tone: PlatformBanner['tone']; until: string }>({ message: '', tone: 'info', until: '' });
  const [signups, setSignups] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  useEffect(() => {
    if (settings.loading || loaded) return;
    const s = settings.data;
    setSupport({ ...EMPTY_SUPPORT_CONTACTS, ...s?.support });
    setBannerOn(!!s?.banner);
    if (s?.banner) setBanner({ message: s.banner.message, tone: s.banner.tone, until: s.banner.until ? toLocalInput(s.banner.until) : '' });
    setSignups(s?.signupsOpen !== false);
    setLoaded(true);
  }, [settings.loading, settings.data, loaded]);

  if (!loaded) return <Spinner label={t('common.loading')} />;

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      await call('updatePlatformSettings', {
        support,
        banner: bannerOn ? { message: banner.message, tone: banner.tone, until: banner.until ? new Date(banner.until).getTime() : null } : null,
        signupsOpen: signups,
      });
      setMessage({ tone: 'success', text: t('adminSettings.saved') });
    } catch (err) {
      setMessage({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const field = (k: keyof SupportContacts, type = 'text') => (
    <TextField
      label={t(`adminSettings.support.${k}`)}
      type={type}
      value={support[k]}
      disabled={!canEdit}
      maxLength={k === 'email' ? 200 : k === 'hours' ? 120 : 30}
      onChange={(e) => setSupport({ ...support, [k]: e.target.value })}
    />
  );

  return (
    <>
      <PageHeader title={t('nav.admin.settings')} description={t('adminSettings.description')} />
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      {!canEdit ? <Alert tone="info">{t('adminSettings.readOnly')}</Alert> : null}

      <section className="wxp-card admin-settings__section">
        <h2 className="section-title">{t('adminSettings.supportTitle')}</h2>
        <p className="wxp-muted">{t('adminSettings.supportHint')}</p>
        <div className="wxp-form__row">
          {field('email', 'email')}
          {field('phone', 'tel')}
        </div>
        <div className="wxp-form__row">
          {field('whatsapp', 'tel')}
          {field('hours')}
        </div>
      </section>

      <section className="wxp-card admin-settings__section">
        <h2 className="section-title">{t('adminSettings.bannerTitle')}</h2>
        <label className="checkbox-row">
          <input type="checkbox" checked={bannerOn} disabled={!canEdit} onChange={(e) => setBannerOn(e.target.checked)} />
          {t('adminSettings.bannerOn')}
        </label>
        {bannerOn ? (
          <>
            <TextAreaField
              label={t('adminSettings.bannerMessage')}
              hint={t('adminSettings.bannerHint')}
              required
              maxLength={300}
              rows={2}
              value={banner.message}
              disabled={!canEdit}
              onChange={(e) => setBanner({ ...banner, message: e.target.value })}
            />
            <div className="wxp-form__row">
              <SelectField
                label={t('adminSettings.bannerTone')}
                options={(['info', 'warning'] as const).map((v) => ({ value: v, label: t(`adminSettings.tones.${v}`) }))}
                value={banner.tone}
                disabled={!canEdit}
                onChange={(e) => setBanner({ ...banner, tone: e.target.value as PlatformBanner['tone'] })}
              />
              <TextField
                label={t('adminSettings.bannerUntil')}
                hint={t('adminSettings.bannerUntilHint')}
                type="datetime-local"
                value={banner.until}
                disabled={!canEdit}
                onChange={(e) => setBanner({ ...banner, until: e.target.value })}
              />
            </div>
          </>
        ) : null}
      </section>

      <section className="wxp-card admin-settings__section">
        <h2 className="section-title">{t('adminSettings.signupsTitle')}</h2>
        <label className="checkbox-row">
          <input type="checkbox" checked={signups} disabled={!canEdit} onChange={(e) => setSignups(e.target.checked)} />
          {t('adminSettings.signupsOpen')}
        </label>
        <p className="wxp-field__hint">{t('adminSettings.signupsHint')}</p>
      </section>

      <PaymentSettings canEdit={canEdit} />

      <section className="wxp-card admin-settings__section">
        <h2 className="section-title">{t('adminSettings.playerTitle')}</h2>
        <p className="wxp-muted wxp-tabular">
          {settings.data?.playerSignerSha256 ? t('adminSettings.playerSigner', { sha: settings.data.playerSignerSha256 }) : t('adminSettings.playerSignerNone')}
        </p>
      </section>

      {canEdit ? (
        <div className="wxp-toolbar">
          <Button variant="primary" disabled={busy || (bannerOn && !banner.message.trim())} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** Online payments (Razorpay): the switch, GST and where trial customers go when they pay. */
function PaymentSettings({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation();
  const settings = usePlatformSettings();
  const plans = usePlans();
  const [form, setForm] = useState<OnlinePaymentSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  useEffect(() => {
    if (settings.loading || form) return;
    setForm(settings.data?.payments ?? { enabled: false, supplierStateCode: '27', gstRateBps: DEFAULT_GST_RATE_BPS, trialPlanTo: null });
  }, [settings.loading, settings.data, form]);
  if (!form) return null;

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      await call('updatePaymentSettings', form);
      setMessage({ tone: 'success', text: t('adminSettings.saved') });
    } catch (err) {
      setMessage({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const paid = plans.data.filter((p) => p.tier !== 'trial' && p.active);
  return (
    <section className="wxp-card admin-settings__section">
      <h2 className="section-title">{t('adminSettings.payments.title')}</h2>
      <p className="wxp-muted">{t('adminSettings.payments.hint')}</p>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      <label className="checkbox-row">
        <input type="checkbox" checked={form.enabled} disabled={!canEdit} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
        {t('adminSettings.payments.enabled')}
      </label>
      <div className="wxp-form__row">
        <SelectField
          label={t('adminSettings.payments.state')}
          options={INDIAN_STATES.map((s) => ({ value: s.code, label: `${s.code} · ${s.name}` }))}
          value={form.supplierStateCode}
          disabled={!canEdit}
          onChange={(e) => setForm({ ...form, supplierStateCode: e.target.value })}
        />
        <TextField
          label={t('adminSettings.payments.gst')}
          type="number"
          min={0}
          max={50}
          step={0.01}
          value={String(form.gstRateBps / 100)}
          disabled={!canEdit}
          onChange={(e) => setForm({ ...form, gstRateBps: Math.round(Number(e.target.value) * 100) })}
        />
      </div>
      <SelectField
        label={t('adminSettings.payments.trialPlan')}
        hint={t('adminSettings.payments.trialPlanHint')}
        options={[{ value: '', label: t('adminSettings.payments.trialPlanNone') }, ...paid.map((p) => ({ value: p.id, label: p.name }))]}
        value={form.trialPlanTo ?? ''}
        disabled={!canEdit}
        onChange={(e) => setForm({ ...form, trialPlanTo: e.target.value || null })}
      />
      <p className="wxp-field__hint">{t('adminSettings.payments.webhook', { url: 'https://asia-south1-wallx-play.cloudfunctions.net/razorpayWebhook' })}</p>
      {canEdit ? (
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          {t('adminSettings.payments.save')}
        </Button>
      ) : null}
    </section>
  );
}
