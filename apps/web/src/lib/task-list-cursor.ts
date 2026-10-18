/**
 * GET /api/tasks's full list pages newest first with a keyset cursor, and
 * says `hasMore` rather than stopping silently at a cap (spec 3ef37387 R-19).
 */
import { isUuid } from './uuid';

/** Rows per page of the full list; `hasMore` and `nextCursor` say when there are more. */
export const TASK_LIST_PAGE = 200;

/** `<createdAt ISO>_<id>`: the full list's keyset cursor (newest first). */
export function encodeTaskCursor(row: { createdAt: Date | string; id: string }): string {
  return `${new Date(row.createdAt).toISOString()}_${row.id}`;
}

export function decodeTaskCursor(raw: string | null): { createdAt: Date; id: string } | null | 'invalid' {
  if (raw === null || raw === '') return null;
  const at = raw.lastIndexOf('_');
  if (at <= 0) return 'invalid';
  const createdAt = new Date(raw.slice(0, at));
  const id = raw.slice(at + 1);
  if (Number.isNaN(createdAt.getTime()) || !isUuid(id)) return 'invalid';
  return { createdAt, id };
}
