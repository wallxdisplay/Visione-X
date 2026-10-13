import type { LayoutBody, PlaylistItem } from '@wallx-play/layout-spec';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { LayoutView, PlaylistPlayer, RenderLibraryProvider, type RenderLibrary } from '../render/Render';

function useViewport() {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

/** Full-screen preview of a layout or playlist, as a screen would show it. Esc closes. */
export function PreviewOverlay({
  library,
  layout,
  playlist,
  canvas = { width: 1920, height: 1080 },
  onClose,
}: {
  library: RenderLibrary;
  layout?: Pick<LayoutBody, 'canvas' | 'zones'>;
  playlist?: PlaylistItem[];
  canvas?: { width: number; height: number };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const vp = useViewport();
  const size = layout?.canvas ?? canvas;
  const width = Math.min(vp.w * 0.92, ((vp.h * 0.85) * size.width) / size.height);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="preview-overlay" role="dialog" aria-modal="true" aria-label={t('studio.preview')}>
      <button type="button" className="preview-overlay__close" aria-label={t('common.close')} onClick={onClose}>
        <X size={22} />
      </button>
      <RenderLibraryProvider value={library}>
        {layout ? (
          <LayoutView layout={layout} width={width} />
        ) : (
          <div className="r-canvas" style={{ width, aspectRatio: `${size.width} / ${size.height}`, background: '#000' }}>
            <PlaylistPlayer items={playlist ?? []} />
          </div>
        )}
      </RenderLibraryProvider>
      <p className="preview-overlay__hint">{t('studio.previewHint', { w: size.width, h: size.height })}</p>
    </div>,
    document.body,
  );
}
