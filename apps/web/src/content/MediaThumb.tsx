import type { MediaDoc } from '@wallx-play/shared';
import { FileAudio, FileImage, FileVideo, Loader2, TriangleAlert } from 'lucide-react';
import { useStorageUrl } from './data';

const ICON = { image: FileImage, video: FileVideo, audio: FileAudio } as const;

/** Thumbnail with clear placeholders for uploading / processing / failed / audio items. */
export function MediaThumb({ media }: { media: MediaDoc }) {
  const url = useStorageUrl(media.status === 'ready' ? media.thumb?.path : null);
  const Icon = ICON[media.type];
  if (url) return <img src={url} alt="" className="media-thumb__img" loading="lazy" />;
  return (
    <div className="media-thumb__placeholder" aria-hidden>
      {media.status === 'failed' ? (
        <TriangleAlert size={28} />
      ) : media.status === 'ready' ? (
        <Icon size={28} />
      ) : (
        <Loader2 size={28} className="spin" />
      )}
    </div>
  );
}
