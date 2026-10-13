/**
 * Content: media, folders, layouts, playlists, screen groups and schedules.
 * Stored-document shapes plus the request schemas of their callable functions.
 */
import { z } from 'zod';
import { LayoutBody, PlaylistItem, type Canvas, type Zone } from '@visione-x/layout-spec';
import { Timezone } from './api';

// ---------------------------------------------------------------- media

export const MEDIA_TYPES = ['image', 'video', 'audio'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

const MB = 1024 * 1024;

/** Accepted uploads. Video is capped so a single processing run fits the function's limits. */
export const MEDIA_LIMITS: Record<MediaType, { maxBytes: number; mimeTypes: readonly string[] }> = {
  image: { maxBytes: 50 * MB, mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] },
  video: { maxBytes: 500 * MB, mimeTypes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'] },
  audio: { maxBytes: 100 * MB, mimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/ogg'] },
};

export function mediaTypeForMime(mimeType: string): MediaType | null {
  return MEDIA_TYPES.find((t) => MEDIA_LIMITS[t].mimeTypes.includes(mimeType)) ?? null;
}

export const MEDIA_STATUSES = ['uploading', 'processing', 'ready', 'failed'] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export interface MediaVariant {
  path: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  sha256?: string;
}

/** orgs/{orgId}/media/{mediaId}; binaries live in Storage under orgs/{orgId}/media/{mediaId}/. */
export interface MediaDoc {
  id: string;
  name: string;
  type: MediaType;
  status: MediaStatus;
  mimeType: string;
  /** Declared at upload; the actual size is verified when processing. */
  bytes: number;
  /** Original + all variants, counted against the storage quota. */
  storedBytes: number;
  originalPath: string;
  /** What screens play (may be the original when no conversion was needed). */
  display?: MediaVariant;
  thumb?: MediaVariant;
  width?: number;
  height?: number;
  durationSec?: number;
  folderId: string | null;
  tags: string[];
  error?: string;
  processingStartedAt?: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export const mediaStoragePath = (orgId: string, mediaId: string, file: string) =>
  `orgs/${orgId}/media/${mediaId}/${file}`;

/** orgs/{orgId}/folders/{folderId} */
export interface FolderDoc {
  id: string;
  name: string;
  createdAt: number;
}

// ---------------------------------------------------------------- layouts & playlists

interface ContentMeta {
  mediaIds: string[];
  playlistIds: string[];
  layoutIds: string[];
  /** Sensor devices bound by widgets (absent on content saved before phase 5). */
  sensorDeviceIds?: string[];
  /** Data sources (weather, RSS) used by widgets (absent before phase 6). */
  dataSourceIds?: string[];
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  updatedAt: number;
}

/** orgs/{orgId}/layouts/{layoutId} */
export interface LayoutDoc extends ContentMeta {
  id: string;
  specVersion: 1;
  name: string;
  canvas: Canvas;
  zones: Zone[];
}

/** orgs/{orgId}/playlists/{playlistId} */
export interface PlaylistDoc extends ContentMeta {
  id: string;
  name: string;
  items: PlaylistItem[];
  totalDurationSec: number;
}

// ---------------------------------------------------------------- screens & schedules

/** orgs/{orgId}/screenGroups/{groupId} */
export interface ScreenGroupDoc {
  id: string;
  name: string;
  siteId: string | null;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export const ScheduleTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('sites'), ids: z.array(z.string()).min(1).max(50) }),
  z.object({ kind: z.literal('groups'), ids: z.array(z.string()).min(1).max(50) }),
]);
export type ScheduleTarget = z.infer<typeof ScheduleTarget>;

/** orgs/{orgId}/schedules/{scheduleId} */
export interface ScheduleDoc {
  id: string;
  name: string;
  playlistId: string;
  target: ScheduleTarget;
  priority: number;
  timezone: string;
  startDate: string | null;
  endDate: string | null;
  daysOfWeek: number[];
  windowStart: string | null;
  windowEnd: string | null;
  enabled: boolean;
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  updatedAt: number;
}

// ---------------------------------------------------------------- request schemas

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const name = z.string().trim().min(1).max(120);
const tag = z.string().trim().toLowerCase().min(1).max(30);

export const CreateMediaUploadInput = z.object({
  orgId: id,
  name: z.string().trim().min(1).max(200),
  mimeType: z.string().max(100),
  bytes: z.number().int().positive(),
  folderId: id.nullable().optional(),
});

export const UpdateMediaInput = z.object({
  orgId: id,
  mediaId: id,
  name: z.string().trim().min(1).max(200).optional(),
  folderId: id.nullable().optional(),
  tags: z.array(tag).max(20).optional(),
});

export const DeleteMediaInput = z.object({ orgId: id, mediaId: id });

export const UpsertFolderInput = z.object({ orgId: id, folderId: id.optional(), name });
export const DeleteFolderInput = z.object({ orgId: id, folderId: id });

export const SaveLayoutInput = z.object({ orgId: id, layoutId: id.optional(), layout: LayoutBody });
export const DeleteLayoutInput = z.object({ orgId: id, layoutId: id });

export const SavePlaylistInput = z.object({
  orgId: id,
  playlistId: id.optional(),
  name,
  items: z.array(PlaylistItem).max(200),
});
export const DeletePlaylistInput = z.object({ orgId: id, playlistId: id });

export const UpsertScreenGroupInput = z.object({
  orgId: id,
  groupId: id.optional(),
  name: z.string().trim().min(1).max(80),
  siteId: id.nullable(),
  description: z.string().trim().max(300).optional(),
});
export const DeleteScreenGroupInput = z.object({ orgId: id, groupId: id });

const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');

export const SaveScheduleInput = z
  .object({
    orgId: id,
    scheduleId: id.optional(),
    name,
    playlistId: id,
    target: ScheduleTarget,
    priority: z.number().int().min(0).max(100),
    timezone: Timezone,
    startDate: LocalDate.nullable(),
    endDate: LocalDate.nullable(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7),
    windowStart: LocalTime.nullable(),
    windowEnd: LocalTime.nullable(),
    enabled: z.boolean(),
  })
  .refine((s) => !s.startDate || !s.endDate || s.startDate <= s.endDate, {
    message: 'End date must not be before the start date',
    path: ['endDate'],
  })
  .refine((s) => (s.windowStart === null) === (s.windowEnd === null), {
    message: 'Set both start and end time, or neither for all day',
    path: ['windowEnd'],
  })
  .refine((s) => s.windowStart === null || s.windowStart !== s.windowEnd, {
    message: 'Start and end time must differ',
    path: ['windowEnd'],
  });
export const DeleteScheduleInput = z.object({ orgId: id, scheduleId: id });
