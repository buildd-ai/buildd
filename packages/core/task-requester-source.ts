/**
 * How a task's person (`tasks.createdByUserId`) was decided, stored in
 * `tasks.requesterSource`. Written by the `tasks_resolve_requester` trigger
 * (migration *_task_requester_trigger), never by application code.
 *
 * Pure: no imports, safe for schema.ts and client bundles.
 */
export const LIVE_REQUESTER_SOURCES = ['explicit', 'parent', 'mission', 'schedule', 'none'] as const;
export type LiveRequesterSource = (typeof LIVE_REQUESTER_SOURCES)[number];

/** The one-time backfill of rows written before the trigger. */
export const BACKFILL_REQUESTER_SOURCES = ['backfill_parent', 'backfill_mission', 'backfill_schedule', 'backfill_none', 'backfill_not_member'] as const;
export type BackfillRequesterSource = (typeof BACKFILL_REQUESTER_SOURCES)[number];

export type TaskRequesterSource = LiveRequesterSource | BackfillRequesterSource;


/**
 * How a mission's person (`missions.createdByUserId`) was decided, stored in
 * `missions.requesterSource`: 'explicit' when a person filed it themselves,
 * 'parent' when an agent filed it and the person is the requester of the
 * agent's task, 'none' when there is no person. Never the agent's own
 * authority: an agent filing for a person is not that person's direct action.
 */
export const MISSION_REQUESTER_SOURCES = ['explicit', 'parent', 'none'] as const;
export type MissionRequesterSource = (typeof MISSION_REQUESTER_SOURCES)[number];
