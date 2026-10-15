import { Alert, Button, TextField } from '@wallx-play/ui';
import { BRAND_LOGO_MAX_BYTES, BrandInput, brandPalette, type Brand, type BrandTarget } from '@wallx-play/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, errorMessage } from '../lib/api';
import { fieldErrors } from '../lib/format';
import './brand.css';

const dataUrlBytes = (s: string) => Math.floor(((s.length - s.indexOf(',') - 1) * 3) / 4);

/**
 * Shrinks an image to at most 512 px on its longest side and encodes it (WebP, else PNG) under
 * the logo size limit, lowering quality / size as needed. Transparent backgrounds are kept.
 */
async function logoFromFile(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  for (const side of [512, 384, 256, 192, 128]) {
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.92, 0.8, 0.65]) {
      const webp = canvas.toDataURL('image/webp', quality);
      const url = webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
      if (dataUrlBytes(url) <= BRAND_LOGO_MAX_BYTES) return url;
    }
  }
  throw new Error('too_big');
}

/** Name, logo, colour and support contact of a reseller's or an organization's brand. */
export function BrandEditor({ target, current, onSaved }: { target: BrandTarget; current: Brand | null; onSaved?: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState({
    name: current?.name ?? '',
    logo: current?.logo ?? null,
    primaryColor: current?.primaryColor ?? '#4F46E5',
    supportEmail: current?.supportEmail ?? '',
    supportPhone: current?.supportPhone ?? '',
    website: current?.website ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof v>(k: K, value: (typeof v)[K]) => {
    setSaved(false);
    setV((p) => ({ ...p, [k]: value }));
  };
  const color = /^#[0-9A-Fa-f]{6}$/.test(v.primaryColor) ? v.primaryColor : '#4F46E5';
  const palette = brandPalette(color);

  async function pickLogo(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      set('logo', await logoFromFile(file));
    } catch {
      setError(t('brand.logoError'));
    }
  }

  async function save(remove = false) {
    const parsed = remove ? null : BrandInput.safeParse(v);
    if (parsed && !parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      await call('saveBrand', { target, brand: parsed ? parsed.data : null });
      setSaved(true);
      onSaved?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="brand-editor">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {saved ? <Alert tone="success">{t('brand.saved')}</Alert> : null}
      <div className="brand-editor__grid">
        <div className="wxp-form">
          <TextField label={t('brand.name')} hint={t('brand.nameHint')} required maxLength={40} value={v.name} error={errors.name} onChange={(e) => set('name', e.target.value)} />
          <div className="wxp-field">
            <span className="wxp-field__label">{t('brand.logo')}</span>
            <div className="brand-editor__logo-row">
              {v.logo ? <img src={v.logo} alt="" className="brand-editor__logo" /> : <span className="wxp-muted">{t('brand.noLogo')}</span>}
              <label className="wxp-btn wxp-btn--secondary wxp-btn--sm">
                {t('brand.chooseLogo')}
                <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void pickLogo(e.target.files?.[0])} />
              </label>
              {v.logo ? (
                <Button size="sm" variant="tertiary" onClick={() => set('logo', null)}>
                  {t('brand.removeLogo')}
                </Button>
              ) : null}
            </div>
            <span className="wxp-field__hint">{t('brand.logoHint')}</span>
          </div>
          <label className="wxp-field">
            <span className="wxp-field__label">{t('brand.color')}</span>
            <span className="color-row">
              <input type="color" className="color-input" value={color} onChange={(e) => set('primaryColor', e.target.value.toUpperCase())} />
              <input className="wxp-input brand-editor__hex" value={v.primaryColor} maxLength={7} onChange={(e) => set('primaryColor', e.target.value)} aria-label={t('brand.color')} />
            </span>
            {errors.primaryColor ? <span className="wxp-field__error">{errors.primaryColor}</span> : null}
          </label>
          <div className="wxp-form__row">
            <TextField label={t('brand.supportEmail')} type="email" maxLength={200} value={v.supportEmail} error={errors.supportEmail} onChange={(e) => set('supportEmail', e.target.value)} />
            <TextField label={t('brand.supportPhone')} type="tel" maxLength={30} value={v.supportPhone} onChange={(e) => set('supportPhone', e.target.value)} />
          </div>
          <TextField label={t('brand.website')} type="url" placeholder="https://" maxLength={200} value={v.website} error={errors.website} onChange={(e) => set('website', e.target.value)} />
        </div>

        <div className="brand-preview" aria-label={t('brand.preview')}>
          <div className="brand-preview__label wxp-muted">{t('brand.preview')}</div>
          <div className="brand-preview__app">
            <div className="brand-preview__bar">
              {v.logo ? <img src={v.logo} alt="" /> : <span className="brand-preview__mark" style={{ background: color, color: palette.onPrimary }}>{(v.name || 'W').slice(0, 1).toUpperCase()}</span>}
              <strong>{v.name || t('brand.namePlaceholder')}</strong>
            </div>
            <div className="brand-preview__body">
              <span className="brand-preview__chip" style={{ background: palette.soft, color: palette.pressed }}>
                {t('brand.previewChip')}
              </span>
              <span className="brand-preview__button" style={{ background: color, color: palette.onPrimary }}>
                {t('brand.previewButton')}
              </span>
              <small className="wxp-muted">{t('brand.poweredBy')}</small>
            </div>
          </div>
          <div className="brand-preview__screen">
            {v.logo ? <img src={v.logo} alt="" /> : null}
            <strong>{v.name || t('brand.namePlaceholder')}</strong>
            <small>{t('brand.previewScreen')}</small>
          </div>
        </div>
      </div>
      <div className="wxp-toolbar">
        <Button variant="primary" disabled={busy || !v.name.trim()} onClick={() => void save()}>
          {t('common.save')}
        </Button>
        {current ? (
          <Button variant="tertiary" disabled={busy} onClick={() => void save(true)}>
            {t('brand.remove')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
