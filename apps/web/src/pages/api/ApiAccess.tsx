import { Alert, Button, Card, Dialog, PageHeader, StatusChip, TextField } from '@wallx-play/ui';
import {
  API_SCOPES,
  WEBHOOK_EVENTS,
  paths,
  type ApiKeyDoc,
  type ApiScope,
  type WebhookDelivery,
  type WebhookDeliveryDoc,
  type WebhookDoc,
  type WebhookEvent,
} from '@wallx-play/shared';
import { collection, limit, orderBy, query } from 'firebase/firestore';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, errorMessage } from '../../lib/api';
import { db } from '../../lib/firebase';
import { formatDateTime } from '../../lib/format';
import { useQueryData, type WithId } from '../../lib/hooks';
import { useOrg } from '../../org/OrgProvider';
import './api.css';
import { FeatureLocked } from '../../content/apps';

export const API_BASE = 'https://wallx-play.web.app/api/v1';

/** Organization API keys, webhooks and the API reference (Enterprise). */
export function ApiAccess() {
  const { t } = useTranslation();
  const { orgId, can, entitlements } = useOrg();
  const keysOn = !!entitlements?.features.includes('api.keys');
  const hooksOn = !!entitlements?.features.includes('api.webhooks');
  const manage = can('apikey.manage');

  if (entitlements && !keysOn && !hooksOn) {
    return (
      <>
        <PageHeader title={t('nav.api')} description={t('api.description')} />
        <div className="wxp-card">
          <FeatureLocked feature="api.keys" icon={<KeyRound size={24} aria-hidden />} title={t('api.notInPlanTitle')} fallback={t('api.notInPlanBody')} />
        </div>
      </>
    );
  }
  return (
    <>
      <PageHeader title={t('nav.api')} description={t('api.description')} />
      {!manage ? <Alert tone="info">{t('api.noPermission')}</Alert> : null}
      <div className="api__stack">
        {keysOn && manage ? <ApiKeys orgId={orgId} /> : null}
        {hooksOn && manage ? <Webhooks orgId={orgId} /> : null}
        {keysOn ? <Reference /> : null}
      </div>
    </>
  );
}

/** A secret shown once with a copy button. */
function ShowOnce({ label, value, hint }: { label: string; value: string; hint: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Alert tone="warning">{hint}</Alert>
      <TextField label={label} readOnly value={value} onFocus={(e) => e.target.select()} className="wxp-input api__mono" />
      <div>
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
          }}
        >
          {copied ? t('api.copied') : t('api.copy')}
        </Button>
      </div>
    </>
  );
}

function ApiKeys({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const keys = useQueryData<ApiKeyDoc>(`apiKeys:${orgId}`, () => query(collection(db, paths.apiKeys(orgId)), orderBy('createdAt', 'desc')));
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<WithId<ApiKeyDoc> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function revoke() {
    if (!revoking) return;
    setBusy(true);
    setError(null);
    try {
      await call('revokeApiKey', { orgId, keyId: revoking.id });
      setRevoking(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t('api.keys.title')}>
      <p className="wxp-muted api__intro">{t('api.keys.intro')}</p>
      {error && !revoking ? <Alert tone="danger">{error}</Alert> : null}
      <div className="api__actions">
        <Button variant="primary" onClick={() => setCreating(true)}>
          {t('api.keys.new')}
        </Button>
      </div>
      {keys.data.length === 0 ? (
        <p className="wxp-muted">{t('api.keys.none')}</p>
      ) : (
        <div className="wxp-table-wrap">
          <table className="wxp-table">
            <thead>
              <tr>
                <th>{t('api.keys.name')}</th>
                <th>{t('api.keys.key')}</th>
                <th>{t('api.keys.scopes')}</th>
                <th>{t('api.keys.lastUsed')}</th>
                <th aria-label={t('common.actions')} />
              </tr>
            </thead>
            <tbody>
              {keys.data.map((k) => (
                <tr key={k.id}>
                  <td>
                    {k.name}
                    <div className="wxp-muted">{t('api.keys.created', { at: formatDateTime(k.createdAt) })}</div>
                  </td>
                  <td className="api__mono">{k.hint}</td>
                  <td>
                    <div className="api__chips">
                      {k.scopes.map((s) => (
                        <span key={s} className="api__chip">
                          {s}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="wxp-tabular">{k.lastUsedAt ? formatDateTime(k.lastUsedAt) : t('api.keys.never')}</td>
                  <td className="wxp-actions">
                    {k.revokedAt ? (
                      <StatusChip tone="neutral">{t('api.keys.revoked')}</StatusChip>
                    ) : (
                      <Button size="sm" variant="tertiary" onClick={() => setRevoking(k)}>
                        {t('api.keys.revoke')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating ? <NewKeyDialog orgId={orgId} onClose={() => setCreating(false)} /> : null}
      {revoking ? (
        <Dialog
          open
          title={t('api.keys.revokeTitle', { name: revoking.name })}
          onClose={() => setRevoking(null)}
          footer={
            <>
              <Button onClick={() => setRevoking(null)}>{t('common.cancel')}</Button>
              <Button variant="danger" disabled={busy} onClick={() => void revoke()}>
                {t('api.keys.revoke')}
              </Button>
            </>
          }
        >
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <p>{t('api.keys.revokeBody')}</p>
        </Dialog>
      ) : null}
    </Card>
  );
}

function NewKeyDialog({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(['screens:read']);
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await call<{ key: string }>('createApiKey', { orgId, name, scopes });
      setKey(res.key);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={t('api.keys.new')}
      onClose={onClose}
      footer={
        key ? (
          <Button variant="primary" onClick={onClose}>
            {t('common.done')}
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={busy || name.trim().length < 2 || scopes.length === 0} onClick={() => void create()}>
              {t('api.keys.create')}
            </Button>
          </>
        )
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {key ? (
        <ShowOnce label={t('api.keys.key')} value={key} hint={t('api.keys.showOnce')} />
      ) : (
        <>
          <TextField label={t('api.keys.name')} hint={t('api.keys.nameHint')} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          <fieldset className="api__checks">
            <legend>{t('api.keys.scopes')}</legend>
            {API_SCOPES.map((s) => (
              <label key={s} className="checkbox-row">
                <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} />
                <span>
                  <span className="api__mono">{s}</span>
                  <span className="wxp-muted"> — {t(`api.scopes.${s.replace(':', '_')}`)}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </>
      )}
    </Dialog>
  );
}

function deliveryText(t: (k: string, o?: Record<string, unknown>) => string, d: WebhookDelivery) {
  return d.ok ? t('api.hooks.delivered', { status: d.status }) : (d.error ?? t('api.hooks.failed'));
}

function Webhooks({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const hooks = useQueryData<WebhookDoc>(`webhooks:${orgId}`, () => query(collection(db, paths.webhooks(orgId)), orderBy('createdAt', 'desc')));
  const [editing, setEditing] = useState<WithId<WebhookDoc> | 'new' | null>(null);
  const [deliveries, setDeliveries] = useState<WithId<WebhookDoc> | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WithId<WebhookDoc> | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const test = (h: WithId<WebhookDoc>) =>
    run(async () => {
      const d = await call<WebhookDelivery>('testWebhook', { orgId, webhookId: h.id });
      setMessage({ tone: d.ok ? 'success' : 'danger', text: `${t('api.hooks.testResult', { url: h.url })} ${deliveryText(t, d)}` });
    });
  const rotate = (h: WithId<WebhookDoc>) =>
    run(async () => {
      const res = await call<{ secret: string }>('rotateWebhookSecret', { orgId, webhookId: h.id });
      setSecret(res.secret);
    });

  return (
    <Card title={t('api.hooks.title')}>
      <p className="wxp-muted api__intro">{t('api.hooks.intro')}</p>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      <div className="api__actions">
        <Button variant="primary" onClick={() => setEditing('new')}>
          {t('api.hooks.add')}
        </Button>
      </div>
      {hooks.data.length === 0 ? (
        <p className="wxp-muted">{t('api.hooks.none')}</p>
      ) : (
        <div className="wxp-table-wrap">
          <table className="wxp-table">
            <thead>
              <tr>
                <th>{t('api.hooks.url')}</th>
                <th>{t('api.hooks.status')}</th>
                <th>{t('api.hooks.last')}</th>
                <th aria-label={t('common.actions')} />
              </tr>
            </thead>
            <tbody>
              {hooks.data.map((h) => (
                <tr key={h.id}>
                  <td className="api__url">
                    <span className="api__mono">{h.url}</span>
                    <div className="wxp-muted">{t('api.hooks.eventCount', { count: h.events.length })}</div>
                  </td>
                  <td>
                    {h.active ? (
                      <StatusChip tone="success">{t('api.hooks.active')}</StatusChip>
                    ) : h.disabledReason ? (
                      <StatusChip tone="danger">{t('api.hooks.switchedOff')}</StatusChip>
                    ) : (
                      <StatusChip tone="neutral">{t('api.hooks.paused')}</StatusChip>
                    )}
                    {h.disabledReason ? <div className="wxp-field__error">{h.disabledReason}</div> : null}
                  </td>
                  <td>
                    {h.lastDelivery ? (
                      <>
                        <span className={h.lastDelivery.ok ? undefined : 'wxp-field__error'}>{deliveryText(t, h.lastDelivery)}</span>
                        <div className="wxp-muted wxp-tabular">{formatDateTime(h.lastDelivery.at)}</div>
                      </>
                    ) : (
                      <span className="wxp-muted">{t('api.hooks.noneYet')}</span>
                    )}
                  </td>
                  <td className="wxp-actions">
                    <Button size="sm" variant="tertiary" disabled={busy} onClick={() => void test(h)}>
                      {t('api.hooks.test')}
                    </Button>
                    <Button size="sm" variant="tertiary" onClick={() => setDeliveries(h)}>
                      {t('api.hooks.log')}
                    </Button>
                    <Button size="sm" variant="tertiary" onClick={() => setEditing(h)}>
                      {t('common.edit')}
                    </Button>
                    <Button size="sm" variant="tertiary" disabled={busy} onClick={() => void rotate(h)}>
                      {t('api.hooks.rotate')}
                    </Button>
                    <Button size="sm" variant="tertiary" onClick={() => setDeleting(h)}>
                      {t('common.delete')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing ? <WebhookDialog orgId={orgId} hook={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      {deliveries ? <DeliveriesDialog orgId={orgId} hook={deliveries} onClose={() => setDeliveries(null)} /> : null}
      {secret ? (
        <Dialog open title={t('api.hooks.newSecret')} onClose={() => setSecret(null)} footer={<Button variant="primary" onClick={() => setSecret(null)}>{t('common.done')}</Button>}>
          <ShowOnce label={t('api.hooks.secret')} value={secret} hint={t('api.hooks.secretOnce')} />
        </Dialog>
      ) : null}
      {deleting ? (
        <Dialog
          open
          title={t('api.hooks.deleteTitle')}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button onClick={() => setDeleting(null)}>{t('common.cancel')}</Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await call('deleteWebhook', { orgId, webhookId: deleting.id });
                    setDeleting(null);
                  })
                }
              >
                {t('common.delete')}
              </Button>
            </>
          }
        >
          <p>{t('api.hooks.deleteBody', { url: deleting.url })}</p>
        </Dialog>
      ) : null}
    </Card>
  );
}

function WebhookDialog({ orgId, hook, onClose }: { orgId: string; hook: WithId<WebhookDoc> | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState(hook?.url ?? 'https://');
  const [events, setEvents] = useState<WebhookEvent[]>(hook?.events ?? ['screen.offline', 'screen.online']);
  const [active, setActive] = useState(hook?.active ?? true);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await call<{ secret?: string }>('saveWebhook', { orgId, ...(hook ? { webhookId: hook.id } : {}), url: url.trim(), events, active });
      if (res.secret) setSecret(res.secret);
      else onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={hook ? t('api.hooks.edit') : t('api.hooks.add')}
      onClose={onClose}
      footer={
        secret ? (
          <Button variant="primary" onClick={onClose}>
            {t('common.done')}
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={busy || !url.startsWith('https://') || events.length === 0} onClick={() => void save()}>
              {t('common.save')}
            </Button>
          </>
        )
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {secret ? (
        <ShowOnce label={t('api.hooks.secret')} value={secret} hint={t('api.hooks.secretOnce')} />
      ) : (
        <>
          <TextField label={t('api.hooks.url')} hint={t('api.hooks.urlHint')} type="url" value={url} maxLength={500} onChange={(e) => setUrl(e.target.value)} />
          <fieldset className="api__checks">
            <legend>{t('api.hooks.events')}</legend>
            {WEBHOOK_EVENTS.map((ev) => (
              <label key={ev} className="checkbox-row">
                <input type="checkbox" checked={events.includes(ev)} onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))} />
                <span>
                  <span className="api__mono">{ev}</span>
                  <span className="wxp-muted"> — {t(`api.events.${ev.replace('.', '_')}`)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="checkbox-row">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            {t('api.hooks.activeLabel')}
          </label>
        </>
      )}
    </Dialog>
  );
}

function DeliveriesDialog({ orgId, hook, onClose }: { orgId: string; hook: WithId<WebhookDoc>; onClose: () => void }) {
  const { t } = useTranslation();
  const log = useQueryData<WebhookDeliveryDoc>(`deliveries:${orgId}:${hook.id}`, () =>
    query(collection(db, paths.webhookDeliveries(orgId, hook.id)), orderBy('at', 'desc'), limit(30)),
  );
  return (
    <Dialog open title={t('api.hooks.logTitle')} onClose={onClose} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      <p className="wxp-muted api__mono api__url">{hook.url}</p>
      {log.data.length === 0 ? (
        <p className="wxp-muted">{t('api.hooks.noneYet')}</p>
      ) : (
        <ul className="api__log">
          {log.data.map((d) => (
            <li key={d._id}>
              <StatusChip tone={d.ok ? 'success' : 'danger'}>{d.ok ? t('api.hooks.ok') : t('api.hooks.failed')}</StatusChip>
              <span className="api__mono">{d.event}</span>
              <span className="wxp-muted wxp-tabular">{formatDateTime(d.at)}</span>
              <span className="wxp-muted">{t('api.hooks.attempts', { count: d.attempts, ms: d.durationMs })}</span>
              {!d.ok ? <span className="api__error">{deliveryText(t, d)}</span> : null}
            </li>
          ))}
        </ul>
      )}
      <p className="wxp-muted">{t('api.hooks.logKept')}</p>
    </Dialog>
  );
}

const ENDPOINTS: Array<{ method: string; path: string; scope: ApiScope | null; key: string }> = [
  { method: 'GET', path: '/me', scope: null, key: 'me' },
  { method: 'GET', path: '/screens', scope: 'screens:read', key: 'screens' },
  { method: 'GET', path: '/screens/{id}', scope: 'screens:read', key: 'screen' },
  { method: 'POST', path: '/screens/{id}/commands', scope: 'screens:command', key: 'command' },
  { method: 'POST', path: '/publish', scope: 'content:publish', key: 'publish' },
  { method: 'GET', path: '/emergencies', scope: 'screens:read', key: 'emergencies' },
  { method: 'POST', path: '/emergencies', scope: 'emergency:write', key: 'emergency' },
  { method: 'POST', path: '/emergencies/{id}/end', scope: 'emergency:write', key: 'endEmergency' },
  { method: 'GET', path: '/reports/plays?from=YYYY-MM-DD&to=YYYY-MM-DD', scope: 'reports:read', key: 'plays' },
  { method: 'GET', path: '/reports/screens?from=YYYY-MM-DD&to=YYYY-MM-DD', scope: 'reports:read', key: 'uptime' },
];

const CURL = `curl ${API_BASE}/screens \\
  -H "Authorization: Bearer wxp_…"

curl -X POST ${API_BASE}/emergencies \\
  -H "Authorization: Bearer wxp_…" -H "Content-Type: application/json" \\
  -d '{"name":"Fire alarm","content":{"kind":"message","text":"Please leave the building"},"durationMinutes":60}'`;

const VERIFY = `// Node.js: check X-WallX-Signature before trusting a webhook
const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
const expected = crypto.createHmac('sha256', secret).update(t + '.' + rawBody).digest('hex');
const valid = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected))
  && Math.abs(Date.now() / 1000 - Number(t)) < 300;`;

function Reference() {
  const { t } = useTranslation();
  return (
    <Card title={t('api.ref.title')}>
      <p>{t('api.ref.intro', { base: API_BASE })}</p>
      <div className="wxp-table-wrap">
        <table className="wxp-table">
          <thead>
            <tr>
              <th>{t('api.ref.endpoint')}</th>
              <th>{t('api.ref.scope')}</th>
              <th>{t('api.ref.what')}</th>
            </tr>
          </thead>
          <tbody>
            {ENDPOINTS.map((e) => (
              <tr key={e.method + e.path}>
                <td className="api__mono api__url">
                  <strong>{e.method}</strong> {e.path}
                </td>
                <td className="api__mono">{e.scope ?? '—'}</td>
                <td>{t(`api.ref.endpoints.${e.key}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="api__subtitle">{t('api.ref.examples')}</h3>
      <pre className="api__code">{CURL}</pre>
      <p className="wxp-muted">{t('api.ref.limits')}</p>
      <h3 className="api__subtitle">{t('api.ref.webhooks')}</h3>
      <p>{t('api.ref.webhooksBody')}</p>
      <pre className="api__code">{VERIFY}</pre>
    </Card>
  );
}
