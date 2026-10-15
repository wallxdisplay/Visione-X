/**
 * Multi-screen sync (Enterprise, screen.multiSync): a sync group plays one playlist on several
 * screens in lockstep. Mirror = the same content on every screen; video wall = one picture
 * spread over a grid of screens, each showing its tile.
 */
import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const SYNC_MODES = ['mirror', 'wall'] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export const MAX_SYNC_SCREENS = 16;
export const MAX_WALL_SIDE = 4;

export interface SyncMember {
  screenId: string;
  /** Video wall cell (0-based); 0/0 in mirror mode. */
  row: number;
  col: number;
}

/** orgs/{orgId}/syncGroups/{groupId} */
export interface SyncGroupDoc {
  id: string;
  name: string;
  mode: SyncMode;
  playlistId: string;
  /** Video wall grid; 1×1 in mirror mode. */
  rows: number;
  cols: number;
  members: SyncMember[];
  enabled: boolean;
  /** Timeline start shared by all members; reset whenever the group's content or screens change. */
  anchor: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export const SaveSyncGroupInput = z
  .object({
    orgId: id,
    groupId: id.optional(),
    name: z.string().trim().min(2).max(60),
    mode: z.enum(SYNC_MODES),
    playlistId: id,
    rows: z.number().int().min(1).max(MAX_WALL_SIDE).default(1),
    cols: z.number().int().min(1).max(MAX_WALL_SIDE).default(1),
    members: z
      .array(z.object({ screenId: id, row: z.number().int().min(0).max(MAX_WALL_SIDE - 1).default(0), col: z.number().int().min(0).max(MAX_WALL_SIDE - 1).default(0) }))
      .min(2)
      .max(MAX_SYNC_SCREENS),
    enabled: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    const ids = v.members.map((m) => m.screenId);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['members'], message: 'A screen can be in the group only once.' });
    if (v.mode === 'wall') {
      if (v.members.length !== v.rows * v.cols) ctx.addIssue({ code: 'custom', path: ['members'], message: 'Fill every cell of the wall with one screen.' });
      const cells = v.members.map((m) => `${m.row}:${m.col}`);
      if (new Set(cells).size !== cells.length) ctx.addIssue({ code: 'custom', path: ['members'], message: 'Each wall cell takes one screen.' });
      if (v.members.some((m) => m.row >= v.rows || m.col >= v.cols)) ctx.addIssue({ code: 'custom', path: ['members'], message: 'A screen is outside the wall grid.' });
    }
  });

export const SyncGroupRefInput = z.object({ orgId: id, groupId: id });
