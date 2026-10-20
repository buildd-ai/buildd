/**
 * How a task's person (`tasks.createdByUserId`) was decided, stored in
 * `tasks.requesterSource`. To be written by a database insert trigger (a
 * follow-up migration), never by application code; until then it stays NULL.
 *
 * Pure: no imports, safe for schema.ts and client bundles.
 */
export const LIVE_REQUESTER_SOURCES = ['explicit', 'parent', 'mission', 'schedule', 'none'] as const;
export type LiveRequesterSource = (typeof LIVE_REQUESTER_SOURCES)[number];

/** The one-time backfill of rows written before the trigger. */
export const BACKFILL_REQUESTER_SOURCES = ['backfill_parent', 'backfill_mission', 'backfill_schedule', 'backfill_none', 'backfill_not_member'] as const;
export type BackfillRequesterSource = (typeof BACKFILL_REQUESTER_SOURCES)[number];

export type TaskRequesterSource = LiveRequesterSource | BackfillRequesterSource;

