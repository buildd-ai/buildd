import { db } from '@buildd/core/db';
import { specMetadataChanges, specs } from '@buildd/core/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { fail, reach, type SpecCaller, type SpecError, type SpecRow } from './store';
import { specApprover } from './approval';

/**
 * Retiring a Living Spec (docs/specs/living-specs.md §22): a person takes a
 * spec out of force without deleting it. `retired` when nothing replaces it,
 * `superseded` when a live spec in the same workspace does. Every reader that
 * already treats those statuses as closed (the index, areas, approval,
 * revise, attachments, the import confirm list) follows.
 *
 * Who: the same people who approve (approval.ts specApprover): an owner or
 * admin of the workspace's team, or a delegated approver, from a dashboard
 * session or their own OAuth session. An agent run or API key gets a 403.
 * Unlike approve, an OAuth session acts directly: retiring is undone by
 * restore, and nothing it does is graded or pinned.
 *
 * Record: no new column. One statement moves the status (only while it is what
 * was read, bumping the version so a pending approval link goes stale) and
 * writes one `spec_metadata_changes` row with field `status`, the previous and
 * new status, the replacement, who and why. Restore reads the newest such row
 * to put the previous status back.
 */

export const RETIRED_STATUSES = ['retired', 'superseded'] as const;
const isRetired = (s: string) => (RETIRED_STATUSES as readonly string[]).includes(s);

const NOT_A_PERSON = 'Retiring a spec is a person\'s decision: an owner or admin of this team, or a delegated approver, from their own session. An agent run or API key cannot retire or restore one.';

export interface RetirementView {
  status: 'retired' | 'superseded';
  reason: string;
  supersededBy: { id: string; title: string } | null;
  /** `user:<id>` of the person who retired it. */
  by: string;
  at: string;
}

const rowsOf = (r: unknown) => ((r as { rows?: unknown[] }).rows ?? []);

async function loadForPerson(caller: SpecCaller, specId: string): Promise<{ spec: SpecRow; personId: string } | SpecError> {
  if (!isUuid(specId)) return fail(404, 'Spec not found');
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec) return fail(404, 'Spec not found');
  const reached = reach(caller, spec.workspaceId, false);
  const [ok, personId] = await Promise.all([reached, specApprover(caller, spec.workspaceId, reached)]);
  if (!ok) return fail(404, 'Spec not found');
  if (!personId) return fail(403, NOT_A_PERSON);
  return { spec, personId };
}

async function writeStatus(spec: SpecRow, personId: string, next: string, reason: string, newValue: Record<string, unknown>): Promise<{ ok: true; spec: SpecRow } | SpecError> {
  const res = await db.execute(sql`
    WITH up AS (
      UPDATE specs SET status = ${next}, version = version + 1, updated_at = now()
      WHERE id = ${spec.id}::uuid AND version = ${spec.version} AND status = ${spec.status}
      RETURNING id, workspace_id
    )
    INSERT INTO spec_metadata_changes (workspace_id, spec_id, field, previous_value, new_value, reason, changed_by_kind, changed_by)
    SELECT up.workspace_id, up.id, 'status', ${JSON.stringify({ status: spec.status })}::jsonb, ${JSON.stringify(newValue)}::jsonb, ${reason}, 'user', ${`user:${personId}`}
    FROM up
    RETURNING id`);
  if (rowsOf(res).length === 0) return fail(409, 'The spec changed while you were deciding. Re-read it and try again.');
  const [after] = await db.select().from(specs).where(eq(specs.id, spec.id)).limit(1);
  return { ok: true, spec: after };
}

/** Retire a spec, or mark it superseded by `supersededBy`. */
export async function retireSpec(caller: SpecCaller, specId: string, input: { reason: unknown; supersededBy?: unknown }): Promise<{ ok: true; spec: SpecRow } | SpecError> {
  if (typeof input.reason !== 'string' || input.reason.trim().length < 10 || input.reason.length > 500) {
    return fail(400, 'reason (why this spec is retired, 10-500 characters) is required');
  }
  const by = input.supersededBy;
  if (by !== undefined && by !== null && (typeof by !== 'string' || !isUuid(by))) return fail(400, 'supersededBy must be a spec id');
  const loaded = await loadForPerson(caller, specId);
  if ('ok' in loaded) return loaded;
  const { spec, personId } = loaded;
  if (isRetired(spec.status)) return fail(409, `This spec is already ${spec.status}. Restore it first.`);
  let replacement: { id: string } | null = null;
  if (typeof by === 'string') {
    if (by === spec.id) return fail(400, 'A spec cannot be superseded by itself');
    const [r] = await db.select({ id: specs.id, workspaceId: specs.workspaceId, status: specs.status }).from(specs).where(eq(specs.id, by)).limit(1);
    if (!r || r.workspaceId !== spec.workspaceId) return fail(400, 'supersededBy names no spec in this workspace');
    if (isRetired(r.status)) return fail(400, `The replacement is ${r.status} itself: name a live spec`);
    replacement = { id: r.id };
  }
  const next = replacement ? 'superseded' : 'retired';
  return writeStatus(spec, personId, next, input.reason.trim(), replacement ? { status: next, supersededBy: replacement.id } : { status: next });
}

/** The newest status change that retired the spec, when it is retired now. */
async function lastRetirement(spec: Pick<SpecRow, 'id' | 'status'>) {
  if (!isRetired(spec.status)) return null;
  const [row] = await db.select().from(specMetadataChanges)
    .where(and(eq(specMetadataChanges.specId, spec.id), eq(specMetadataChanges.field, 'status')))
    .orderBy(desc(specMetadataChanges.createdAt)).limit(1);
  return row ?? null;
}

/** Put a retired or superseded spec back to the status it had before. */
export async function restoreSpec(caller: SpecCaller, specId: string, input: { reason?: unknown }): Promise<{ ok: true; spec: SpecRow } | SpecError> {
  const loaded = await loadForPerson(caller, specId);
  if ('ok' in loaded) return loaded;
  const { spec, personId } = loaded;
  if (!isRetired(spec.status)) return fail(409, `This spec is ${spec.status}, not retired: nothing to restore`);
  const last = await lastRetirement(spec);
  const prev = (last?.previousValue as { status?: unknown } | null)?.status;
  // With no record (retired before this existed), the status its revisions imply.
  const back = typeof prev === 'string' && !isRetired(prev) ? prev : spec.approvedRevision != null ? 'approved' : 'draft';
  const reason = typeof input.reason === 'string' && input.reason.trim().length >= 3 ? input.reason.trim().slice(0, 500) : 'restored';
  return writeStatus(spec, personId, back, reason, { status: back });
}

/** Why and by what a spec is retired, for its page; null when it is not. */
export async function specRetirement(specId: string): Promise<RetirementView | null> {
  if (!isUuid(specId)) return null;
  const [spec] = await db.select({ id: specs.id, status: specs.status }).from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec) return null;
  const last = await lastRetirement(spec);
  if (!last) return null;
  const nv = (last.newValue ?? {}) as { supersededBy?: unknown };
  let supersededBy: RetirementView['supersededBy'] = null;
  if (typeof nv.supersededBy === 'string' && isUuid(nv.supersededBy)) {
    const [r] = await db.select({ id: specs.id, title: specs.title }).from(specs).where(eq(specs.id, nv.supersededBy)).limit(1);
    supersededBy = r ?? null;
  }
  return { status: spec.status as RetirementView['status'], reason: last.reason, supersededBy, by: last.changedBy, at: last.createdAt.toISOString() };
}
