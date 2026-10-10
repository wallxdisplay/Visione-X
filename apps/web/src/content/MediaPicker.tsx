import { Button, Dialog, EmptyState } from '@visione-x/ui';
import type { MediaDoc, MediaType } from '@visione-x/shared';
import { Check, Images } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { MediaThumb } from './MediaThumb';
import { formatDuration } from './data';

/** Pick ready media items (single or multiple). */
export function MediaPicker({
  open,
  media,
  types,
  multiple = false,
  onClose,
  onPick,
}: {
  open: boolean;
  media: MediaDoc[];
  types: MediaType[];
  multiple?: boolean;
  onClose: () => void;
  onPick: (items: MediaDoc[]) => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const choices = useMemo(
    () =>
      media.filter(
        (m) => m.status === 'ready' && types.includes(m.type) && m.name.toLowerCase().includes(search.trim().toLowerCase()),
      ),
    [media, types, search],
  );

  function toggle(id: string) {
    if (!multiple) {
      const item = media.find((m) => m.id === id);
      if (item) onPick([item]);
      return;
    }
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  function close() {
    setSelected([]);
    setSearch('');
    onClose();
  }

  return (
    <Dialog
      open={open}
      title={t('library.pickTitle')}
      size="lg"
      onClose={close}
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          {multiple ? (
            <Button
              variant="primary"
              disabled={selected.length === 0}
              onClick={() => {
                onPick(selected.map((id) => media.find((m) => m.id === id)!).filter(Boolean));
                setSelected([]);
              }}
            >
              {t('library.addSelected', { count: selected.length })}
            </Button>
          ) : null}
        </>
      }
    >
      <input
        className="vx-input"
        placeholder={t('library.search')}
        aria-label={t('library.search')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {choices.length === 0 ? (
        <EmptyState
          icon={<Images size={24} aria-hidden />}
          title={t('library.pickEmpty')}
          action={<Link to="/library">{t('library.openLibrary')}</Link>}
        />
      ) : (
        <div className="picker-grid">
          {choices.map((m) => {
            const isSelected = selected.includes(m.id);
            return (
              <button
                key={m.id}
                type="button"
                className={`picker-item${isSelected ? ' picker-item--selected' : ''}`}
                aria-pressed={multiple ? isSelected : undefined}
                onClick={() => toggle(m.id)}
              >
                <div className="media-thumb">
                  <MediaThumb media={m} />
                  {isSelected ? (
                    <span className="picker-item__check" aria-hidden>
                      <Check size={14} />
                    </span>
                  ) : null}
                </div>
                <span className="picker-item__name">{m.name}</span>
                {m.durationSec ? <span className="vx-muted">{formatDuration(m.durationSec)}</span> : null}
              </button>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
