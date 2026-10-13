import { Alert, Button, Dialog, EmptyState, PageHeader, SelectField, TextField } from '@wallx-play/ui';
import { BUILT_IN_TEMPLATES, RESOLUTION_PRESETS, layoutFromTemplate, type LayoutBody } from '@wallx-play/layout-spec';
import type { LayoutDoc } from '@wallx-play/shared';
import { Copy, LayoutTemplate, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { useRenderLibrary } from '../../content/useLibrary';
import { call, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useOrg } from '../../org/OrgProvider';
import { LayoutView, RenderLibraryProvider } from '../../render/Render';

export function StudioList() {
  const { t } = useTranslation();
  const { orgId, can } = useOrg();
  const { library, layouts } = useRenderLibrary(orgId);
  const navigate = useNavigate();
  const editable = can('layout.edit');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<LayoutDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(body: LayoutBody) {
    const { layoutId } = await call<{ layoutId: string }>('saveLayout', { orgId, layout: body });
    return layoutId;
  }

  async function duplicate(l: LayoutDoc) {
    setError(null);
    try {
      await save({ name: t('studio.copyOf', { name: l.name }).slice(0, 80), canvas: l.canvas, zones: l.zones });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError(null);
    try {
      await call('deleteLayout', { orgId, layoutId: deleting.id });
      setDeleting(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title={t('nav.studio')}
        description={t('studio.description')}
        actions={
          editable ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={16} aria-hidden /> {t('studio.new')}
            </Button>
          ) : null
        }
      />
      {error && !deleting ? <Alert tone="danger">{error}</Alert> : null}

      {layouts.data.length === 0 && !layouts.loading ? (
        <div className="wxp-card">
          <EmptyState
            icon={<LayoutTemplate size={24} aria-hidden />}
            title={t('studio.emptyTitle')}
            description={t('studio.emptyBody')}
            action={
              editable ? (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  {t('studio.new')}
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <RenderLibraryProvider value={library}>
          <div className="layout-grid">
            {layouts.data.map((l) => (
              <div key={l.id} className="layout-card">
                <Link to={`/studio/${l.id}`} className="layout-card__preview" aria-label={l.name}>
                  <div className={`layout-card__frame layout-card__frame--${l.canvas.orientation}`}>
                    <LayoutView layout={l} fill />
                  </div>
                </Link>
                <div className="layout-card__body">
                  <Link to={`/studio/${l.id}`} className="layout-card__name">
                    {l.name}
                  </Link>
                  <span className="wxp-muted">
                    {l.canvas.width}×{l.canvas.height} · {t('studio.zoneCount', { count: l.zones.length })} ·{' '}
                    {formatDateTime(l.updatedAt)}
                  </span>
                </div>
                {editable ? (
                  <div className="layout-card__actions">
                    <Button size="sm" variant="tertiary" aria-label={t('studio.duplicate')} title={t('studio.duplicate')} onClick={() => void duplicate(l)}>
                      <Copy size={15} />
                    </Button>
                    <Button size="sm" variant="tertiary" aria-label={t('common.delete')} title={t('common.delete')} onClick={() => setDeleting(l)}>
                      <Trash2 size={15} />
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </RenderLibraryProvider>
      )}

      {creating ? (
        <NewLayoutDialog
          onClose={() => setCreating(false)}
          onCreate={async (body) => {
            const id = await save(body);
            navigate(`/studio/${id}`);
          }}
        />
      ) : null}

      <Dialog
        open={!!deleting}
        title={t('studio.deleteTitle')}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <p>{t('studio.deleteBody', { name: deleting?.name })}</p>
      </Dialog>
    </>
  );
}

function NewLayoutDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (body: LayoutBody) => Promise<void> }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('l-bar');
  const [preset, setPreset] = useState('fhd');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const template = BUILT_IN_TEMPLATES.find((x) => x.id === templateId)!;

  async function create() {
    const size = RESOLUTION_PRESETS.find((p) => p.id === preset)!;
    setBusy(true);
    setError(null);
    try {
      await onCreate(layoutFromTemplate(template, name.trim() || t(`templates.${template.key}`), size));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={t('studio.new')}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void create()}>
            {t('studio.create')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField label={t('studio.name')} value={name} placeholder={t(`templates.${template.key}`)} onChange={(e) => setName(e.target.value)} />
      <fieldset className="template-picker">
        <legend className="wxp-field__label">{t('studio.template')}</legend>
        {BUILT_IN_TEMPLATES.map((tpl) => (
          <label key={tpl.id} className={`template-option${tpl.id === templateId ? ' template-option--selected' : ''}`}>
            <input type="radio" name="template" value={tpl.id} checked={tpl.id === templateId} onChange={() => setTemplateId(tpl.id)} />
            <span className={`template-option__frame template-option__frame--${tpl.orientation}`} aria-hidden>
              {tpl.zones.map((z, i) => (
                <span key={i} style={{ left: `${z.x * 100}%`, top: `${z.y * 100}%`, width: `${z.w * 100}%`, height: `${z.h * 100}%` }} />
              ))}
            </span>
            <span>{t(`templates.${tpl.key}`)}</span>
          </label>
        ))}
      </fieldset>
      <SelectField
        label={t('studio.resolution')}
        hint={t('studio.resolutionHint')}
        options={RESOLUTION_PRESETS.map((p) => ({ value: p.id, label: t(`studio.presets.${p.id}`, { w: p.width, h: p.height }) }))}
        value={preset}
        onChange={(e) => setPreset(e.target.value)}
      />
    </Dialog>
  );
}
