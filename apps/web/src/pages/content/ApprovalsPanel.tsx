import { Alert, Button, Card, TextField } from '@visione-x/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePendingApprovals } from '../../content/ops';
import { call, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useOrg } from '../../org/OrgProvider';

/** Pending publish requests for approvers (content.approve). */
export function ApprovalsPanel() {
  const { t } = useTranslation();
  const { orgId, can } = useOrg();
  const approvals = usePendingApprovals(orgId, can('content.approve'));
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  if (!approvals.data.length) return null;

  async function decide(approvalId: string, decision: 'approve' | 'reject') {
    setBusy(approvalId);
    setMessage(null);
    try {
      const note = notes[approvalId]?.trim();
      const res = await call<{ published: number }>('reviewPublish', { orgId, approvalId, decision, ...(note ? { note } : {}) });
      setMessage({
        tone: 'success',
        text: decision === 'approve' ? t('approvals.approved', { count: res.published }) : t('approvals.rejected'),
      });
    } catch (err) {
      setMessage({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title={t('approvals.title', { count: approvals.data.length })}>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      <ul className="approvals">
        {approvals.data.map((a) => (
          <li key={a.id} className="approvals__item">
            <div>
              <strong>{a.requestedByEmail ?? a.requestedBy}</strong>{' '}
              <span className="vx-muted">
                {t('approvals.requested', {
                  at: formatDateTime(a.requestedAt),
                  screens: a.screenIds.length ? a.screenIds.length : t('approvals.allScreens'),
                })}
              </span>
              {a.note ? <p className="approvals__note">“{a.note}”</p> : null}
            </div>
            <div className="approvals__actions">
              <TextField
                label={t('approvals.note')}
                value={notes[a.id] ?? ''}
                maxLength={500}
                onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })}
              />
              <div className="vx-toolbar" style={{ margin: 0 }}>
                <Button size="sm" variant="tertiary" disabled={busy === a.id} onClick={() => void decide(a.id, 'reject')}>
                  {t('approvals.reject')}
                </Button>
                <Button size="sm" variant="primary" disabled={busy === a.id} onClick={() => void decide(a.id, 'approve')}>
                  {t('approvals.approve')}
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <p className="vx-muted" style={{ marginBottom: 0 }}>{t('approvals.hint')}</p>
    </Card>
  );
}
