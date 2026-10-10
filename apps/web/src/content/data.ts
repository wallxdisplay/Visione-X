import { collection, orderBy, query } from 'firebase/firestore';
import { getDownloadURL, ref } from 'firebase/storage';
import { useEffect, useMemo, useState } from 'react';
import {
  paths,
  type FolderDoc,
  type LayoutDoc,
  type MediaDoc,
  type PlaylistDoc,
  type ScheduleDoc,
  type ScreenGroupDoc,
  type SiteDoc,
} from '@visione-x/shared';
import { db, storage } from '../lib/firebase';
import { useQueryData } from '../lib/hooks';

/** Live content collections of the current org. */
export const useMediaList = (orgId: string) =>
  useQueryData<MediaDoc>(`media:${orgId}`, () => query(collection(db, paths.mediaCol(orgId)), orderBy('createdAt', 'desc')));
export const useFolders = (orgId: string) =>
  useQueryData<FolderDoc>(`folders:${orgId}`, () => query(collection(db, paths.folders(orgId)), orderBy('name')));
export const useLayouts = (orgId: string) =>
  useQueryData<LayoutDoc>(`layouts:${orgId}`, () => query(collection(db, paths.layouts(orgId)), orderBy('updatedAt', 'desc')));
export const usePlaylists = (orgId: string) =>
  useQueryData<PlaylistDoc>(`playlists:${orgId}`, () =>
    query(collection(db, paths.playlists(orgId)), orderBy('updatedAt', 'desc')),
  );
export const useScreenGroups = (orgId: string) =>
  useQueryData<ScreenGroupDoc>(`groups:${orgId}`, () => query(collection(db, paths.screenGroups(orgId)), orderBy('name')));
export const useSchedules = (orgId: string) =>
  useQueryData<ScheduleDoc>(`schedules:${orgId}`, () =>
    query(collection(db, paths.schedules(orgId)), orderBy('priority', 'desc')),
  );
export const useSites = (orgId: string) =>
  useQueryData<SiteDoc>(`sites:${orgId}`, () => query(collection(db, paths.sites(orgId)), orderBy('name')));

export function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((i) => [i.id, i]));
}

export function useById<T extends { id: string }>(items: T[]): Map<string, T> {
  return useMemo(() => byId(items), [items]);
}

const urlCache = new Map<string, Promise<string>>();

/** Download URL for a Storage path (access is checked by Storage rules). Cached per session. */
export function useStorageUrl(path: string | undefined | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    let p = urlCache.get(path);
    if (!p) {
      p = getDownloadURL(ref(storage, path));
      p.catch(() => urlCache.delete(path));
      urlCache.set(path, p);
    }
    p.then((u) => !cancelled && setUrl(u)).catch(() => !cancelled && setUrl(null));
    return () => {
      cancelled = true;
    };
  }, [path]);
  return url;
}

/** Browsers sometimes leave File.type empty (e.g. .mkv); fall back to the extension. */
export function mimeForFile(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    mkv: 'video/x-matroska',
    mov: 'video/quicktime',
    mp4: 'video/mp4',
    webm: 'video/webm',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
  };
  return (ext && map[ext]) || 'application/octet-stream';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

export function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export const newId = () => Math.random().toString(36).slice(2, 10);
