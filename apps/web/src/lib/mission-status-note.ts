/**
 * The body of the feed note a mission status change writes (PATCH
 * /api/missions/[id]). Shared because GET /api/missions/recent reads it back:
 * `missions.completedAt` keeps the first completion on that path, so the note
 * is the record of a later re-completion. Pure, no db import.
 */
export function missionStatusNoteBody(from: string, to: string): string {
  return `${from} → ${to}`;
}

/** LIKE pattern matching every status-change note into `to`. */
export function missionStatusNoteIntoPattern(to: string): string {
  return missionStatusNoteBody('%', to);
}

/** Titles used in mission status change notes (PATCH /api/missions/[id] and GET /api/missions/recent). */
export const MISSION_STATUS_CHANGE_TITLES = ['Mission status changed', 'Mission reopened'] as const;
