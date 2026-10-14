import { collection, limit, orderBy, query } from 'firebase/firestore';
import { Alert, Button, Dialog, SelectField, StatusChip, TextField } from '@wallx-play/ui';
import { paths, SUPPORT_DURATIONS_HOURS, SUPPORT_LEVELS, supportGrantActive, type SupportGrantDoc, type SupportLevel } from '@wallx-play/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, errorMessage } from '../../lib/api';
import { db } from '../../lib/firebase';
import { formatDateTime } from '../../lib/format';
import { useQueryData } from '../../lib/hooks';
import { useOrg } from '../../org/OrgProvider';

const TONE = { requested: 'warning', active: 'success', declined: 'neutral', revoked: 'neutral', expired: 'neutral' } as const;

/** Help & Support: who at WallX can see this organization, and for how long. */
export function SupportAccessPanel() {
  const { t } = useTranslation();
  const { orgId, can } = useOrg();
  const manage = can('member.manage');
  const grants = useQueryData<SupportGrantDoc>(`supportGrants:${orgId}`, () => query(collection(db, paths.supportGrants(orgId)), orderBy('createdAt', 'desc'), limit(20)));
  const [giving, setGiving] = useState(false);
  const [level, setLevel] = useState<SupportLevel>('view');
  const [hours, setHours] = useState<number>(4);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();
  const open = grants.data.filter((g) => g.status === 'requested' || supportGrantActive(g, now));
  const past = grants.data.filter((g) => !open.includes(g)).slice(0, 5);

  async function run(action: () => Promise<unknown>, done?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await action();
      done?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const row = (g: SupportGrantDoc) => (
    <li key={g.id} className="support-grant">
      <div className="support-grant__main">
        <StatusChip tone={g.status === 'active' && !supportGrantActive(g, now) ? 'neutral' : TONE[g.status]}>{t(`supportAccess.status.${g.status === 'active' && !supportGrantActive(g, now) ? 'expired' : g.status}`)}</StatusChip>{' '}
        <strong>{t(`supportAccess.levels.${g.level}`)}</strong>
        <span className="wxp-muted"> · {t(`supportAccess.origins.${g.origin}`, { email: g.requestedBy?.email ?? '' })}</span>
        {g.reason ? <div className="wxp-muted">“{g.reason}”</div> : null}
        <div className="wxp-muted wxp-tabular">
          {g.status === 'requested'
            ? t('supportAccess.requestedFor', { hours: g.hours, at: formatDateTime(g.createdAt) })
            : g.expiresAt && supportGrantActive(g, now)
              ? t('supportAccess.until', { at: formatDateTime(g.expiresAt) })
              : g.endedAt
                ? t('supportAccess.ended', { at: formatDateTime(g.endedAt) })
                : null}
          {g.openedBy.length ? ` · ${t('supportAccess.opened', { count: g.openedBy.length })}` : ''}
        </div>
      </div>
      {manage ? (
        <div className="wxp-actions">
          {g.status === 'requested' ? (
            <>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void run(() => call('respondSupportRequest', { orgId, grantId: g.id, approve: true }))}>
                {t('supportAccess.approve')}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void run(() => call('respondSupportRequest', { orgId, grantId: g.id, approve: false }))}>
                {t('supportAccess.decline')}
              </Button>
            </>
          ) : supportGrantActive(g, now) ? (
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(() => call('revokeSupportAccess', { orgId, grantId: g.id }))}>
              {t('supportAccess.end')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );

  return (
    <section className="wxp-card help__section">
      <div className="team__section-head" style={{ marginTop: 0 }}>
        <h2 className="section-title">{t('supportAccess.title')}</h2>
        {manage ? (
          <Button size="sm" onClick={() => setGiving(true)}>
            {t('supportAccess.give')}
          </Button>
        ) : null}
      </div>
      <p className="wxp-muted">{t('supportAccess.explain')}</p>
      {error && !giving ? <Alert tone="danger">{error}</Alert> : null}
      {open.length ? <ul className="support-grants">{open.map(row)}</ul> : <p>{t('supportAccess.none')}</p>}
      {past.length ? (
        <details>
          <summary className="wxp-muted">{t('supportAccess.history')}</summary>
          <ul className="support-grants">{past.map(row)}</ul>
        </details>
      ) : null}

      <Dialog
        open={giving}
        title={t('supportAccess.give')}
        onClose={() => setGiving(false)}
        footer={
          <>
            <Button onClick={() => setGiving(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void run(() => call('grantSupportAccess', { orgId, level, hours, reason: note }), () => { setGiving(false); setNote(''); })}
            >
              {t('supportAccess.giveConfirm')}
            </Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <SelectField
          label={t('supportAccess.level')}
          options={SUPPORT_LEVELS.map((l) => ({ value: l, label: t(`supportAccess.levels.${l}`) }))}
          value={level}
          hint={t(`supportAccess.levelHints.${level}`)}
          onChange={(e) => setLevel(e.target.value as SupportLevel)}
        />
        <SelectField
          label={t('supportAccess.duration')}
          options={SUPPORT_DURATIONS_HOURS.map((h) => ({ value: String(h), label: t('supportAccess.hours', { count: h }) }))}
          value={String(hours)}
          onChange={(e) => setHours(Number(e.target.value))}
        />
        <TextField label={t('supportAccess.note')} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        <p className="wxp-field__hint">{t('supportAccess.giveHint')}</p>
      </Dialog>
    </section>
  );
}
