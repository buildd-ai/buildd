import { db } from '@buildd/core/db';
import { specRevisions, specs, workspaces } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { requestingPerson } from '@/lib/request-person';
import { holdsInWorkspace } from '@/lib/team-access';
import { fail, reach, type SpecCaller, type SpecError, type SpecRevisionRow, type SpecRow } from './store';

/**
 * Living Specs approval (G2, decision D-4): a person decides that one revision
 * of a spec is in force. Agents draft and revise; they never submit or approve.
 *
 * Who may submit or approve: a person (a dashboard session, or the person's
 * own OAuth session, never an API key or a per-task token; lib/request-person.ts)
 * who is an owner or admin of the workspace's team, or a member the workspace
 * names as a delegated approver (`gitConfig.livingSpecs.approverUserIds`).
 *
 * An approval stamps one revision once (`approved_at` is set only while it is
 * NULL) and moves `specs.approved_revision` to it in the same statement. The
 * body it approves is an artifact revision, which the artifact trigger keeps
 * immutable, so an approved revision is never mutated: a later revise proposes
 * N+1 and leaves N in force until a person approves N+1.
 */

/** The approving person's user id, or null when the caller may not approve here. */
export async function specApprover(caller: SpecCaller, workspaceId: string): Promise<string | null> {
  const personId = caller.kind === 'user' ? caller.userId : requestingPerson(null, caller.account);
  if (!personId) return null;
  if (await holdsInWorkspace(personId, workspaceId, 'approve_specs')) return personId;
  // A delegated approver is a member of the team the workspace names.
  if (!(await reach({ kind: 'user', userId: personId }, workspaceId, false))) return null;
  const [ws] = await db.select({ gitConfig: workspaces.gitConfig }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const ids = ((ws?.gitConfig as { livingSpecs?: { approverUserIds?: unknown } } | null)?.livingSpecs?.approverUserIds);
  return Array.isArray(ids) && ids.includes(personId) ? personId : null;
}

const NOT_A_PERSON = 'Approving a spec is a person\'s decision: an owner or admin of this team, or a delegated approver, from their own session. An agent run or API key cannot submit or approve.';

async function loadForDecision(caller: SpecCaller, specId: string, expectedVersion: unknown): Promise<{ spec: SpecRow; approver: string } | SpecError> {
  if (!isUuid(specId)) return fail(404, 'Spec not found');
  if (!Number.isInteger(expectedVersion)) return fail(400, 'expectedVersion (the spec version you read) is required');
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !(await reach(caller, spec.workspaceId, false))) return fail(404, 'Spec not found');
  const approver = await specApprover(caller, spec.workspaceId);
  if (!approver) return fail(403, NOT_A_PERSON);
  if (spec.status === 'retired' || spec.status === 'superseded') return fail(409, `A ${spec.status} spec is not approved`);
  if (spec.version !== expectedVersion) {
    return fail(409, `The spec changed since version ${expectedVersion as number}: it is now at version ${spec.version}. Re-read it before deciding.`, { currentVersion: spec.version });
  }
  return { spec, approver };
}

const rowsOf = (r: unknown) => ((r as { rows?: unknown[] }).rows ?? []);

/** Mark the draft head as ready for a decision (draft → in_review). */
export async function submitSpecRevision(caller: SpecCaller, specId: string, input: { expectedVersion: unknown }): Promise<{ ok: true; spec: SpecRow } | SpecError> {
  const loaded = await loadForDecision(caller, specId, input.expectedVersion);
  if ('ok' in loaded) return loaded;
  const { spec } = loaded;
  if (spec.status !== 'draft') return fail(409, `Only a draft is submitted; this spec is ${spec.status}`);
  if (spec.approvedRevision === spec.headRevision) return fail(409, `Revision ${spec.headRevision} is already approved; revise it to propose a change`);
  const rows = await db.execute(sql`
    UPDATE specs SET status = 'in_review', version = version + 1, updated_at = now()
    WHERE id = ${specId}::uuid AND version = ${spec.version} AND status = 'draft'
    RETURNING id`);
  if (rowsOf(rows).length === 0) return conflictNow(specId);
  const [after] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  return { ok: true, spec: after };
}

/**
 * Approve revision `revision`, which must be the head. One statement stamps
 * the revision (only while unstamped) and moves the spec's approved revision
 * to it, both only while the spec is still at `expectedVersion` with that head,
 * so a racing revise or a second approver changes nothing.
 */
export async function approveSpecRevision(caller: SpecCaller, specId: string, input: { revision: unknown; expectedVersion: unknown }): Promise<{ ok: true; spec: SpecRow; revision: SpecRevisionRow } | SpecError> {
  if (!Number.isInteger(input.revision)) return fail(400, 'revision (the spec revision you read and are approving) is required');
  const loaded = await loadForDecision(caller, specId, input.expectedVersion);
  if ('ok' in loaded) return loaded;
  const { spec, approver } = loaded;
  const n = input.revision as number;
  if (n !== spec.headRevision) return fail(409, `Revision ${n} is not the head (revision ${spec.headRevision}); only the head is approved. Read it, then approve it.`, { currentVersion: spec.version });
  if (spec.approvedRevision === n) return fail(409, `Revision ${n} is already approved`, { currentVersion: spec.version });

  const label = `user:${approver}`;
  const rows = await db.execute(sql`
    WITH stamp AS (
      UPDATE spec_revisions SET approved_by = ${label}, approved_at = now()
      WHERE spec_id = ${specId}::uuid AND revision = ${n} AND approved_at IS NULL
        AND EXISTS (SELECT 1 FROM specs WHERE id = ${specId}::uuid AND version = ${spec.version} AND head_revision = ${n})
      RETURNING revision
    )
    UPDATE specs SET approved_revision = ${n}, status = 'approved', version = version + 1, updated_at = now()
    WHERE id = ${specId}::uuid AND version = ${spec.version} AND head_revision = ${n} AND EXISTS (SELECT 1 FROM stamp)
    RETURNING id`);
  if (rowsOf(rows).length === 0) return conflictNow(specId);
  const [after] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  const [revision] = await db.select().from(specRevisions).where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, n))).limit(1);
  return { ok: true, spec: after, revision };
}

async function conflictNow(specId: string): Promise<SpecError> {
  const [now] = await db.select({ version: specs.version }).from(specs).where(eq(specs.id, specId)).limit(1);
  return fail(409, `The spec changed while you were deciding: it is now at version ${now?.version}. Re-read it before deciding.`, { currentVersion: now?.version });
}
