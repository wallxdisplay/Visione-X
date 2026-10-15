import { Button, PageHeader } from '@wallx-play/ui';
import { Clock, Mail, MessageCircle, Phone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { effectiveBrand } from '@wallx-play/shared';
import { Link } from 'react-router';
import { usePlatformSettings } from '../../lib/platformSettings';
import { useOrg } from '../../org/OrgProvider';
import { SupportAccessPanel } from './SupportAccessPanel';

/** Short how-tos, each pointing at the page where the job is done. */
const GUIDES = [
  { key: 'pair', to: '/screens' },
  { key: 'content', to: '/library' },
  { key: 'publish', to: '/playlists' },
  { key: 'schedule', to: '/schedules' },
  { key: 'emergency', to: '/screens' },
  { key: 'sensors', to: '/sensors' },
  { key: 'team', to: '/team' },
  { key: 'billing', to: '/billing' },
] as const;

/** Help & Support: contacts, quick guides and WallX support access. */
export function Help() {
  const { t } = useTranslation();
  const { orgId, org, entitlements } = useOrg();
  const brand = org ? effectiveBrand(org, entitlements) : null;
  const brandContact = !!(brand && (brand.supportEmail || brand.supportPhone || brand.website));
  const settings = usePlatformSettings();
  const s = settings.data?.support;
  const whatsappDigits = s?.whatsapp.replace(/\D/g, '');
  const hasContact = !!(s?.email || s?.phone || s?.whatsapp);

  return (
    <>
      <PageHeader title={t('nav.help')} description={t('help.description')} />
      {brandContact && brand ? (
        <section className="wxp-card help__section">
          <h2 className="section-title">{t('brand.contactTitle', { name: brand.name })}</h2>
          <ul className="help__contacts">
            {brand.supportEmail ? (
              <li>
                <a href={`mailto:${brand.supportEmail}`}>{brand.supportEmail}</a>
              </li>
            ) : null}
            {brand.supportPhone ? (
              <li>
                <a href={`tel:${brand.supportPhone.replace(/\s/g, '')}`}>{brand.supportPhone}</a>
              </li>
            ) : null}
            {brand.website ? (
              <li>
                <a href={brand.website} target="_blank" rel="noreferrer">
                  {brand.website}
                </a>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      <section className="wxp-card help__section">
        <h2 className="section-title">{t('help.contactTitle')}</h2>
        {hasContact ? (
          <ul className="help__contacts">
            {s?.email ? (
              <li>
                <Mail size={18} aria-hidden />
                <a href={`mailto:${s.email}?subject=${encodeURIComponent(`${org?.name ?? ''} (${orgId})`)}`}>{s.email}</a>
              </li>
            ) : null}
            {s?.phone ? (
              <li>
                <Phone size={18} aria-hidden />
                <a href={`tel:${s.phone.replace(/\s/g, '')}`}>{s.phone}</a>
              </li>
            ) : null}
            {s?.whatsapp && whatsappDigits ? (
              <li>
                <MessageCircle size={18} aria-hidden />
                <a href={`https://wa.me/${whatsappDigits}`} target="_blank" rel="noreferrer">
                  {t('help.whatsapp', { number: s.whatsapp })}
                </a>
              </li>
            ) : null}
            {s?.hours ? (
              <li>
                <Clock size={18} aria-hidden />
                <span>{s.hours}</span>
              </li>
            ) : null}
          </ul>
        ) : (
          <p className="wxp-muted">{t('help.noContacts')}</p>
        )}
        <p className="wxp-muted">
          {t('help.orgId')} <code className="wxp-tabular">{orgId}</code>{' '}
          <Button size="sm" variant="tertiary" onClick={() => void navigator.clipboard?.writeText(orgId)}>
            {t('help.copy')}
          </Button>
        </p>
      </section>

      <SupportAccessPanel />

      <section className="wxp-card help__section">
        <h2 className="section-title">{t('help.guidesTitle')}</h2>
        <div className="help__guides">
          {GUIDES.map((g) => (
            <article key={g.key} className="help__guide">
              <h3>{t(`help.guides.${g.key}.title`)}</h3>
              <p>{t(`help.guides.${g.key}.body`)}</p>
              <Link to={g.to}>{t(`help.guides.${g.key}.link`)}</Link>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
