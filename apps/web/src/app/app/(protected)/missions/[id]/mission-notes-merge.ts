/**
 * The mission feed's live read (spec 3ef37387 R-21): after the first page, an
 * event fetches only the notes at or after the newest one held
 * (GET /api/missions/[id]/notes?since=<id>) and merges them here, instead of
 * re-reading 50 notes per event. Kept free of React so it is testable.
 */
import type { MissionNote } from '@buildd/shared';

export const NOTES_PAGE = 50;

export function notesUrl(missionId: string, held: readonly Pick<MissionNote, 'id'>[]): string {
  const base = `/api/missions/${missionId}/notes?limit=${NOTES_PAGE}`;
  return held.length > 0 ? `${base}&since=${encodeURIComponent(held[0].id)}` : base;
}

function at(note: Pick<MissionNote, 'createdAt'>): number {
  return new Date(note.createdAt as unknown as string).getTime() || 0;
}

/**
 * Held notes plus what came back since: a returned note replaces its old copy
 * (a collapsed note is re-dated), and a reply marks the open note it answers
 * as answered, as the reply route does on the server.
 */
export function mergeNotesSince<T extends MissionNote>(held: readonly T[], incoming: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const note of held) byId.set(note.id, note);
  for (const note of incoming) byId.set(note.id, note);
  for (const note of incoming) {
    const parentId = (note as { replyTo?: string | null }).replyTo;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent && parent.status === 'open') byId.set(parent.id, { ...parent, status: 'answered' });
  }
  return [...byId.values()].sort((a, b) => at(b) - at(a));
}
