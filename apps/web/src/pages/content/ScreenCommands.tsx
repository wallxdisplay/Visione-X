import { Alert, Button, StatusChip } from '@visione-x/ui';
import { DISRUPTIVE_COMMANDS, SCREEN_COMMANDS, type ScreenCommandDoc, type ScreenCommandType, type ScreenDoc } from '@visione-x/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStorageUrl } from '../../content/data';
import { useScreenCommands } from '../../content/ops';
import { call, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useOrg } from '../../org/OrgProvider';

const TONE = { pending: 'info', delivered: 'info', done: 'success', failed: 'danger', expired: 'neutral' } as const;

/** Remote command buttons + recent results (screenshots, diagnostics) for one screen. */
export function ScreenCommands({ screen }: { screen: ScreenDoc }) {
  const { t } = useTranslation();
  const { orgId, can, entitlements } = useOrg();
  const history = useScreenCommands(orgId, screen.id);
  const [confirming, setConfirming] = useState<ScreenCommandType | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const allowed = can('screen.command') && screen.status === 'authorized';
  const entitled = entitlements?.features.includes('screen.remoteCommands') ?? false;

  async function send(type: ScreenCommandType) {
    setBusy(true);
    setMessage(null);
    try {
      await call('sendScreenCommand', { orgId, screenId: screen.id, type });
      setMessage({ tone: 'success', text: t('commands.queued', { command: t(`commands.types.${type}`) }) });
    } catch (err) {
      setMessage({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  return (
    <section className="commands">
      <div className="studio__panel-title">{t('commands.title')}</div>
      {!entitled ? <Alert tone="info">{t('commands.notInPlan')}</Alert> : null}
      {allowed && entitled ? (
        <div className="vx-toolbar" style={{ margin: 0 }}>
          {SCREEN_COMMANDS.map((type) => (
            <Button
              key={type}
              size="sm"
              variant={DISRUPTIVE_COMMANDS.includes(type) ? 'secondary' : 'tertiary'}
              disabled={busy}
              onClick={() => (DISRUPTIVE_COMMANDS.includes(type) ? setConfirming(type) : void send(type))}
            >
              {t(`commands.types.${type}`)}
            </Button>
          ))}
        </div>
      ) : null}
      {confirming ? (
        <Alert tone="warning" title={t('commands.confirmTitle', { command: t(`commands.types.${confirming}`) })}>
          <p style={{ margin: '4px 0 8px' }}>{t(`commands.confirmBody.${confirming}`)}</p>
          <div className="vx-toolbar" style={{ margin: 0 }}>
            <Button size="sm" onClick={() => setConfirming(null)}>{t('common.cancel')}</Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void send(confirming)}>
              {t(`commands.types.${confirming}`)}
            </Button>
          </div>
        </Alert>
      ) : null}
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      {history.data.length ? (
        <ul className="commands__list">
          {history.data.map((c) => (
            <CommandRow key={c.id} command={c} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function CommandRow({ command }: { command: ScreenCommandDoc }) {
  const { t } = useTranslation();
  const shot = useStorageUrl(command.screenshotPath);
  const [open, setOpen] = useState(false);
  const details = command.result && Object.keys(command.result).length > 0;
  return (
    <li className="commands__item">
      <div className="commands__row">
        <span>{t(`commands.types.${command.type}`)}</span>
        <StatusChip tone={TONE[command.status]}>{t(`commands.status.${command.status}`)}</StatusChip>
        <span className="vx-muted vx-tabular">{formatDateTime(command.completedAt ?? command.createdAt)}</span>
        {details ? (
          <button type="button" className="link-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? t('commands.hide') : t('commands.details')}
          </button>
        ) : null}
      </div>
      {shot ? (
        <a href={shot} target="_blank" rel="noreferrer">
          <img className="commands__shot" src={shot} alt={t('commands.screenshotAlt')} />
        </a>
      ) : null}
      {open && command.result ? (
        <dl className="vx-dl commands__result">
          {Object.entries(command.result).map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}
