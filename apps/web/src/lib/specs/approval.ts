import { db } from '@buildd/core/db';
import { specRevisions, specs, workspaces } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { requestingPerson } from '@/lib/request-person';
import { holdsInWorkspace } from '@/lib/team-access';
import { appBaseUrl } from '@/lib/app-url';
import { fail, reach, type SpecCaller, type SpecError, type SpecRevisionRow, type SpecRow } from './store';
import { signSpecApprovalRequest, specApprovalConfirmPath, verifySpecApprovalRequest } from './approval-request';
import { emit } from '@/lib/core-emit';

/**
 * Living Specs approval (G2, decision D-4): a person decides that one revision
 * of a spec is in force. Agents draft and revise; they never submit or approve.
 *
 * Who may submit or approve: a person (a dashboard session, or the person's
 * own OAuth session, never an API key or a per-task token; lib/request-person.ts)
 * who is an owner or admin of the workspace's team, or a member the workspace
 * names as a delegated approver (`gitConfig.livingSpecs.approverUserIds`).
 *
 * An approve from an OAuth bearer session (MCP or chat) never approves: an
 * agent may be the one driving it. It returns a signed link instead
 * (approval-request.ts), and the revision is approved only when a person
 * confirms that link from their dashboard session (confirmSpecApproval).
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
/** What an approve over MCP or chat returns: the link a person opens to confirm it. */
export interface PendingSpecApproval { confirmUrl: string; revision: number; expiresAt: string }

export async function approveSpecRevision(caller: SpecCaller, specId: string, input: { revision: unknown; expectedVersion: unknown }): Promise<{ ok: true; spec: SpecRow; revision: SpecRevisionRow } | { ok: true; spec: SpecRow; pending: PendingSpecApproval } | SpecError> {
  if (!Number.isInteger(input.revision)) return fail(400, 'revision (the spec revision you read and are approving) is required');
  const loaded = await loadForDecision(caller, specId, input.expectedVersion);
  if ('ok' in loaded) return loaded;
  const { spec, approver } = loaded;
  const n = input.revision as number;
  if (n !== spec.headRevision) return fail(409, `Revision ${n} is not the head (revision ${spec.headRevision}); only the head is approved. Read it, then approve it.`, { currentVersion: spec.version });
  if (spec.approvedRevision === n) return fail(409, `Revision ${n} is already approved`, { currentVersion: spec.version });

  if (caller.kind === 'account') {
    // A bearer session: the person's own, but maybe driven by an agent. Ask, don't approve.
    const [rev] = await db.select({ contentHash: specRevisions.contentHash }).from(specRevisions)
      .where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, n))).limit(1);
    if (!rev) return fail(404, `Revision ${n} not found`);
    const now = Date.now();
    const token = signSpecApprovalRequest({ specId, workspaceId: spec.workspaceId, revision: n, expectedVersion: spec.version, contentHash: rev.contentHash, requestedBy: approver }, now);
    if (!token) return fail(502, 'Approval links are not configured on this deployment. Approve from buildd.dev.');
    const verdict = verifySpecApprovalRequest(token, now);
    const expiresAt = new Date(verdict.ok ? verdict.payload.exp : now).toISOString();
    return { ok: true, spec, pending: { confirmUrl: `${appBaseUrl()}${specApprovalConfirmPath(specId, token)}`, revision: n, expiresAt } };
  }

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
  // Modules react (the knowledge index). emit never throws, so nothing undoes the approval.
  await emit({ type: 'spec.approved', specId, workspaceId: after.workspaceId, revision: n });
  return { ok: true, spec: after, revision };
}

async function conflictNow(specId: string): Promise<SpecError> {
  const [now] = await db.select({ version: specs.version }).from(specs).where(eq(specs.id, specId)).limit(1);
  return fail(409, `The spec changed while you were deciding: it is now at version ${now?.version}. Re-read it before deciding.`, { currentVersion: now?.version });
}

/**
 * A person confirms an approval request made over MCP or chat. Only a
 * dashboard session confirms; the request names one revision, version and
 * body hash, and anything that moved since makes it stale. A request that was
 * already confirmed reads as done and changes nothing.
 */
export async function confirmSpecApproval(caller: SpecCaller, specId: string, token: unknown): Promise<{ ok: true; already: boolean; spec: SpecRow; revision: SpecRevisionRow } | SpecError> {
  if (caller.kind !== 'user') return fail(403, 'Confirm the approval on buildd.dev, signed in. An agent session cannot confirm it.');
  const v = verifySpecApprovalRequest(typeof token === 'string' ? token : null);
  if (!v.ok) {
    return v.reason === 'expired'
      ? fail(400, 'This approval link has expired. Ask for a new one.', { code: 'request_expired' })
      : fail(400, 'This approval link is not valid.', { code: 'request_invalid' });
  }
  const req = v.payload;
  if (!isUuid(specId) || req.specId !== specId) return fail(400, 'This approval link is not valid.', { code: 'request_invalid' });
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !(await reach(caller, spec.workspaceId, false))) return fail(404, 'Spec not found');
  if (spec.workspaceId !== req.workspaceId) return fail(400, 'This approval link is not valid.', { code: 'request_invalid' });
  if (!(await specApprover(caller, spec.workspaceId))) return fail(403, NOT_A_PERSON);
  const [rev] = await db.select().from(specRevisions)
    .where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, req.revision))).limit(1);
  if (!rev || rev.contentHash !== req.contentHash) return fail(409, 'The spec changed since this approval was asked for.', { code: 'request_stale', currentVersion: spec.version });
  if (spec.approvedRevision === req.revision && rev.approvedAt) return { ok: true, already: true, spec, revision: rev };
  if (spec.version !== req.expectedVersion || spec.headRevision !== req.revision) {
    return fail(409, 'The spec changed since this approval was asked for. Ask for a new link.', { code: 'request_stale', currentVersion: spec.version });
  }
  const r = await approveSpecRevision(caller, specId, { revision: req.revision, expectedVersion: req.expectedVersion });
  if (!r.ok) return r.status === 409 ? { ...r, code: 'request_stale' } : r;
  if ('pending' in r) return fail(403, NOT_A_PERSON);
  return { ok: true, already: false, spec: r.spec, revision: r.revision };
}
