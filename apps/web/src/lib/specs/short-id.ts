import { db } from '@buildd/core/db';
import { specs, workspaces } from '@buildd/core/db/schema';
import { eq, sql } from 'drizzle-orm';
import { reach, type SpecCaller } from './store';

/**
 * /app/specs/<short id> (docs/specs/living-specs.md §18, R-33): the link a
 * generated repo copy and `specs:lint` print. A short id is the first 8 hex
 * characters of a spec id. It resolves among the specs the reader can reach
 * (§9): one is that spec, two or more are listed, none is a 404, so a spec in
 * a workspace the reader cannot see never shows through.
 */

export const SHORT_ID = /^[0-9a-f]{8}$/;

export type ShortIdResolution =
  | { state: 'none' }
  | { state: 'one'; id: string }
  | { state: 'many'; specs: Array<{ id: string; title: string; workspaceName: string }> };

export async function resolveSpecShortId(caller: SpecCaller, short: string): Promise<ShortIdResolution> {
  const s = short.toLowerCase();
  if (!SHORT_ID.test(s)) return { state: 'none' };
  const rows = await db.select({ id: specs.id, title: specs.title, workspaceId: specs.workspaceId, workspaceName: workspaces.name })
    .from(specs).innerJoin(workspaces, eq(workspaces.id, specs.workspaceId))
    .where(sql`${specs.id}::text LIKE ${`${s}%`}`).limit(20);
  const reachable = new Map<string, boolean>();
  const visible: typeof rows = [];
  for (const r of rows) {
    if (!reachable.has(r.workspaceId)) reachable.set(r.workspaceId, await reach(caller, r.workspaceId, false));
    if (reachable.get(r.workspaceId)) visible.push(r);
  }
  if (visible.length === 0) return { state: 'none' };
  if (visible.length === 1) return { state: 'one', id: visible[0]!.id };
  return { state: 'many', specs: visible.map((r) => ({ id: r.id, title: r.title, workspaceName: r.workspaceName })) };
}
