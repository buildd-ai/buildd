/**
 * The server half of an enforce-mode path-collision deferral
 * (docs/design/conflict-aware-orchestration.md §2).
 *
 * A runner in enforce mode that finds, at a checkpoint, that a path its task
 * already changed is held by another live task stops the session, saves a
 * checkpoint and reports `status: failed` with a `Deferred:` error plus a
 * `pathCollision` body. The worker PATCH requeues on the `Deferred:` prefix
 * without charging a retry; `recordPathCollisionDeferral` then makes that
 * requeue wait for the holder instead of being reclaimed straight back into
 * the same collision:
 *
 *  - the collided path joins the task's effective `pathManifest`, so the claim
 *    route's active-lease backstop defers the task until the holder's lease is
 *    released (terminal release already wakes it — no agent waits);
 *  - the collision is recorded on `path_declaration.collision`, next to the
 *    original declaration snapshot (taken here if no earlier write took one),
 *    so conformance and audit see why scope grew;
 *  - a pushed checkpoint becomes `context.resumeBranch`, so the next attempt
 *    resumes the saved work rather than starting over.
 *
 * Appending to the manifest is a declaration, not a lease: the lease is taken
 * by the normal exclusive acquisition at the next claim, once the path is free.
 */
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { and, eq, ne, sql } from 'drizzle-orm';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES = new Set(['hook_flush', 'sync', 'pre_push', 'completion']);

export interface PathCollisionReport {
  path: string;
  blockingTaskId: string;
  blockingTaskTitle?: string | null;
  blockingPath?: string | null;
  source: 'hook_flush' | 'sync' | 'pre_push' | 'completion';
  checkpoint?: { committed: boolean; sha?: string; pushed: boolean; reason?: string };
}

function cleanPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const p = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (!p || p === '**' || p.startsWith('/') || p.startsWith('~')) return null;
  if (p.split('/').some(seg => seg === '..')) return null;
  return p.slice(0, 1024);
}

/** Validate the runner's `pathCollision` body. Null when it is not usable. */
export function parsePathCollision(raw: unknown): PathCollisionReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const path = cleanPath(r.path);
  if (!path) return null;
  if (typeof r.blockingTaskId !== 'string' || !UUID.test(r.blockingTaskId)) return null;
  const out: PathCollisionReport = {
    path,
    blockingTaskId: r.blockingTaskId,
    blockingTaskTitle: typeof r.blockingTaskTitle === 'string' ? r.blockingTaskTitle.slice(0, 300) : null,
    blockingPath: typeof r.blockingPath === 'string' ? r.blockingPath.slice(0, 1024) : null,
    source: typeof r.source === 'string' && SOURCES.has(r.source) ? r.source as PathCollisionReport['source'] : 'sync',
  };
  const cp = r.checkpoint as Record<string, unknown> | undefined;
  if (cp && typeof cp === 'object') {
    out.checkpoint = {
      committed: cp.committed === true,
      pushed: cp.pushed === true,
      ...(typeof cp.sha === 'string' && /^[0-9a-f]{7,64}$/i.test(cp.sha) ? { sha: cp.sha } : {}),
      ...(typeof cp.reason === 'string' ? { reason: cp.reason.slice(0, 300) } : {}),
    };
  }
  return out;
}

/**
 * One atomic UPDATE (no interactive transaction). Returns whether a row was
 * written — false when the task was cancelled in between, or on any error.
 * Never throws: the requeue itself already happened.
 */
export async function recordPathCollisionDeferral(input: {
  taskId: string;
  /** The runner's `pathCollision` body, unvalidated; parsed here. */
  collision: unknown;
  /** The worker's branch; becomes the resume branch only if the checkpoint was pushed. */
  branch?: string | null;
}): Promise<boolean> {
  const { taskId } = input;
  const collision = parsePathCollision(input.collision);
  if (!collision) return false;
  const record = JSON.stringify({ ...collision, recordedAt: new Date().toISOString() });
  const pathJson = JSON.stringify(collision.path);
  const resumeBranch = collision.checkpoint?.pushed && input.branch ? input.branch : null;
  try {
    const rows = await db
      .update(tasks)
      .set({
        pathManifest: sql`CASE WHEN COALESCE(${tasks.pathManifest}, '[]'::jsonb) @> jsonb_build_array(${collision.path}::text)
          THEN ${tasks.pathManifest}
          ELSE COALESCE(${tasks.pathManifest}, '[]'::jsonb) || ${pathJson}::jsonb END`,
        pathDeclaration: sql`jsonb_set(
          COALESCE(${tasks.pathDeclaration}, jsonb_build_object('declared', ${tasks.pathManifest}, 'source', 'runtime', 'snapshotAt', now())),
          '{collision}', ${record}::jsonb, true)`,
        ...(resumeBranch
          ? { context: sql`COALESCE(${tasks.context}, '{}'::jsonb) || jsonb_build_object('resumeBranch', ${resumeBranch}::text)` }
          : {}),
        pathClaimRevision: sql`${tasks.pathClaimRevision} + 1`,
        updatedAt: new Date(),
      } as any)
      .where(and(eq(tasks.id, taskId), ne(tasks.status, 'cancelled')))
      .returning({ id: tasks.id });
    return Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    console.error(`[path-collision] could not record deferral for task ${taskId}:`, err);
    return false;
  }
}
