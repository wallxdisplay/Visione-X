import { useMemo } from 'react';
import type { RenderLibrary } from '../render/Render';
import { byId, useLayouts, useMediaList, usePlaylists } from './data';

/** Everything the renderer needs to draw this org's content. */
export function useRenderLibrary(orgId: string) {
  const media = useMediaList(orgId);
  const playlists = usePlaylists(orgId);
  const layouts = useLayouts(orgId);
  const library = useMemo<RenderLibrary>(
    () => ({ media: byId(media.data), playlists: byId(playlists.data), layouts: byId(layouts.data), orgId }),
    [media.data, playlists.data, layouts.data, orgId],
  );
  return { library, media, playlists, layouts, loading: media.loading || playlists.loading || layouts.loading };
}
