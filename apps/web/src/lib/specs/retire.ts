import { db } from '@buildd/core/db';
import { specMetadataChanges, specs } from '@buildd/core/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { fail, reach, type SpecCaller, type SpecError, type SpecRow } from './store';
import { specApprovalDeps, specApprover } from './approval';
import { repoFileOf, restoredRepoNote, retiredRepoLine, retirementRow, type RetirementRepoFile } from './retire-repo-file';
import type { RepoCopyDeps } from './repo-copy';
import { appBaseUrl } from '@/lib/app-url';
import { signSpecStatusRequest, specStatusConfirmPath, verifySpecStatusRequest, type SpecStatusRequest } from './status-request';

/**
 * Retiring a Living Spec (docs/specs/living-specs.md §22): a person takes a
 * spec out of force without deleting it. `retired` when nothing replaces it,
 * `superseded` when a live spec in the same workspace does. Every reader that
 * already treats those statuses as closed (the index, areas, approval,
 * revise, attachments, the import confirm list) follows.
 *
 * Who: the same people who approve (approval.ts specApprover): an owner or
 * admin of the workspace's team, or a delegated approver. An agent run or API
 * key gets a 403. From a dashboard session it acts directly. From the person's
 * own OAuth session (MCP or chat, where an agent may be driving) it changes
 * nothing, like approve: it returns a link pinned to the spec, its version, its
 * status and the reason (status-request.ts), and the change happens only when
 * the person confirms that link from their dashboard (confirmSpecStatusChange;
 * Living Spec b7fc9316 R-11, R-12).
 *
 * Record: no new column. One statement moves the status (only while it is what
 * was read, bumping the version so a pending approval link goes stale) and
 * writes one `spec_metadata_changes` row with field `status`, the previous and
 * new status, the replacement, who and why. Restore reads the newest such row
 * to put the previous status back.
 *
 * Repo file (R-78 to R-80, ./retire-repo-file.ts): after a retirement commits,
 * the one PR on the file that stands for the spec is opened and recorded on that
 * change row. Restore opens nothing; the page says the file still reads superseded.
 */

/** After-response work and the GitHub a retirement's repo PR is written through; overridable for tests. */
export const retireDeps: { afterResponse: (task: () => Promise<unknown>) => void; repoFile?: RepoCopyDeps } = {
  afterResponse: (task) => specApprovalDeps.afterResponse(task),
};

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
  /** The repo file it reached (R-78), and the page's line while its PR is open. */
  repoFile: RetirementRepoFile | null;
  repoLine: { text: string; href: string | null } | null;
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

async function writeStatus(spec: SpecRow, personId: string, next: string, reason: string, newValue: Record<string, unknown>): Promise<{ ok: true; spec: SpecRow; changeId: string } | SpecError> {
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
  const [written] = rowsOf(res) as Array<{ id: string }>;
  if (!written) return fail(409, 'The spec changed while you were deciding. Re-read it and try again.');
  const [after] = await db.select().from(specs).where(eq(specs.id, spec.id)).limit(1);
  return { ok: true, spec: after, changeId: written.id };
}

/** A retire or restore asked for from an OAuth session: the link a person opens to confirm it. */
export interface PendingStatusChange {
  op: 'retire' | 'restore';
  confirmUrl: string;
  expiresAt: string;
  /** The status the spec moves to when confirmed. */
  to: string;
}

type StatusResult = { ok: true; spec: SpecRow } | { ok: true; spec: SpecRow; pending: PendingStatusChange } | SpecError;

/** What a retire would write: the next status and its change-log value, after checking the replacement. */
async function retireTarget(spec: SpecRow, by: string | null): Promise<{ next: 'retired' | 'superseded'; newValue: Record<string, unknown> } | SpecError> {
  if (isRetired(spec.status)) return fail(409, `This spec is already ${spec.status}. Restore it first.`);
  if (by === null) return { next: 'retired', newValue: { status: 'retired' } };
  if (by === spec.id) return fail(400, 'A spec cannot be superseded by itself');
  const [r] = await db.select({ id: specs.id, workspaceId: specs.workspaceId, status: specs.status }).from(specs).where(eq(specs.id, by)).limit(1);
  if (!r || r.workspaceId !== spec.workspaceId) return fail(400, 'supersededBy names no spec in this workspace');
  if (isRetired(r.status)) return fail(400, `The replacement is ${r.status} itself: name a live spec`);
  return { next: 'superseded', newValue: { status: 'superseded', supersededBy: r.id } };
}

/** The status a restore puts back. */
async function restoreTarget(spec: SpecRow): Promise<string | SpecError> {
  if (!isRetired(spec.status)) return fail(409, `This spec is ${spec.status}, not retired: nothing to restore`);
  const last = await lastRetirement(spec);
  const prev = (last?.previousValue as { status?: unknown } | null)?.status;
  // With no record (retired before this existed), the status its revisions imply.
  return typeof prev === 'string' && !isRetired(prev) ? prev : spec.approvedRevision != null ? 'approved' : 'draft';
}

/** From an OAuth session: a link pinned to what was read, and nothing changed. */
function askToConfirm(spec: SpecRow, personId: string, op: 'retire' | 'restore', reason: string, supersededBy: string | null, to: string): StatusResult {
  const now = Date.now();
  const token = signSpecStatusRequest({ op, specId: spec.id, workspaceId: spec.workspaceId, expectedVersion: spec.version, status: spec.status, reason, supersededBy, requestedBy: personId }, now);
  if (!token) return fail(502, `Confirm links are not configured on this deployment. ${op === 'retire' ? 'Retire' : 'Restore'} it on buildd.dev.`);
  const v = verifySpecStatusRequest(token, now);
  return { ok: true, spec, pending: { op, confirmUrl: `${appBaseUrl()}${specStatusConfirmPath(spec.id, token)}`, expiresAt: new Date(v.ok ? v.payload.exp : now).toISOString(), to } };
}

/** After a retirement commits, the one PR on the repo file that stands for the spec (R-78). */
function openRepoPrAfter(spec: SpecRow): void {
  if (!spec.repoSource && !spec.repoCopy?.path) return;
  retireDeps.afterResponse(async () => {
    const { openRetirementPr } = await import('./retire-repo-file');
    await openRetirementPr(spec.id, retireDeps.repoFile);
  });
}

/**
 * Retire a spec, or mark it superseded by `supersededBy`. From an OAuth
 * session, a confirm link instead. `repoFile`: the repo already says so (an
 * import run's retirement, R-79), recorded as is and no PR opened; without it
 * the file that stands for the spec gets its one PR (R-78).
 */
export async function retireSpec(caller: SpecCaller, specId: string, input: { reason: unknown; supersededBy?: unknown }, opts: { repoFile?: RetirementRepoFile } = {}): Promise<StatusResult> {
  if (typeof input.reason !== 'string' || input.reason.trim().length < 10 || input.reason.length > 500) {
    return fail(400, 'reason (why this spec is retired, 10-500 characters) is required');
  }
  const by = input.supersededBy;
  if (by !== undefined && by !== null && (typeof by !== 'string' || !isUuid(by))) return fail(400, 'supersededBy must be a spec id');
  const loaded = await loadForPerson(caller, specId);
  if ('ok' in loaded) return loaded;
  const { spec, personId } = loaded;
  const reason = input.reason.trim();
  const target = await retireTarget(spec, typeof by === 'string' ? by : null);
  if ('ok' in target) return target;
  if (caller.kind === 'account') return askToConfirm(spec, personId, 'retire', reason, typeof by === 'string' ? by : null, target.next);
  const r = await writeStatus(spec, personId, target.next, reason, { ...target.newValue, ...(opts.repoFile ? { repoFile: opts.repoFile } : {}) });
  if (r.ok && !opts.repoFile) openRepoPrAfter(spec);
  return r;
}

/** One replaced spec an approval tried to supersede, and how it went. */
export type ApprovalRetirement =
  | { specId: string; title: string; state: 'superseded' }
  | { specId: string; title: string | null; state: 'stale'; reason: string };

/**
 * R-77: after a person approved `replacement` at `revision`, supersede each
 * spec they left checked. The caller has approved, so it has checked the
 * person's rights in this workspace (the same ones retiring needs, R-51).
 * Each is its own statement and change row naming the approval; one that
 * moved since it was read (a version other than `expectedVersion`, or no
 * longer live) is reported stale and left as it is, and the approval stands.
 */
export async function supersedeOnApproval(personId: string, replacement: { id: string; title: string; workspaceId: string; revision: number }, choice: ReadonlyArray<{ specId: string; expectedVersion?: number }>): Promise<ApprovalRetirement[]> {
  const out: ApprovalRetirement[] = [];
  for (const c of choice) {
    const [spec] = await db.select().from(specs).where(eq(specs.id, c.specId)).limit(1);
    if (!spec || spec.workspaceId !== replacement.workspaceId) { out.push({ specId: c.specId, title: null, state: 'stale', reason: 'not a spec in this workspace' }); continue; }
    const stale = (reason: string) => out.push({ specId: spec.id, title: spec.title, state: 'stale', reason });
    if (isRetired(spec.status)) { stale(`already ${spec.status}`); continue; }
    if (c.expectedVersion !== undefined && spec.version !== c.expectedVersion) { stale(`it changed since the approval was read (version ${spec.version}, not ${c.expectedVersion})`); continue; }
    const reason = `Replaced by "${replacement.title}", approved at revision ${replacement.revision}.`.slice(0, 500);
    const r = await writeStatus(spec, personId, 'superseded', reason, {
      status: 'superseded', supersededBy: replacement.id, approval: { specId: replacement.id, revision: replacement.revision },
    });
    if (!r.ok) { stale('it changed while the approval was written'); continue; }
    out.push({ specId: spec.id, title: spec.title, state: 'superseded' });
    openRepoPrAfter(spec);
  }
  return out;
}

/** The newest status change that retired the spec, when it is retired now. */
async function lastRetirement(spec: Pick<SpecRow, 'id' | 'status'>) {
  if (!isRetired(spec.status)) return null;
  const [row] = await db.select().from(specMetadataChanges)
    .where(and(eq(specMetadataChanges.specId, spec.id), eq(specMetadataChanges.field, 'status')))
    .orderBy(desc(specMetadataChanges.createdAt)).limit(1);
  return row ?? null;
}

/** Put a retired or superseded spec back to the status it had before. From an OAuth session, a confirm link instead. */
export async function restoreSpec(caller: SpecCaller, specId: string, input: { reason?: unknown }): Promise<StatusResult> {
  const loaded = await loadForPerson(caller, specId);
  if ('ok' in loaded) return loaded;
  const { spec, personId } = loaded;
  const back = await restoreTarget(spec);
  if (typeof back !== 'string') return back;
  const reason = typeof input.reason === 'string' && input.reason.trim().length >= 3 ? input.reason.trim().slice(0, 500) : 'restored';
  if (caller.kind === 'account') return askToConfirm(spec, personId, 'restore', reason, null, back);
  return writeStatus(spec, personId, back, reason, { status: back });
}

const INVALID = 'This link is not valid.';

/** The request a link carries, checked against the spec now: still at the version and status it was asked at. */
async function readStatusRequest(caller: SpecCaller, specId: string, token: unknown): Promise<{ spec: SpecRow; personId: string; req: SpecStatusRequest } | SpecError> {
  const v = verifySpecStatusRequest(typeof token === 'string' ? token : null);
  if (!v.ok) return v.reason === 'expired' ? fail(400, 'This link has expired. Ask for a new one.', { code: 'request_expired' }) : fail(400, INVALID, { code: 'request_invalid' });
  const req = v.payload;
  if (!isUuid(specId) || req.specId !== specId) return fail(400, INVALID, { code: 'request_invalid' });
  const loaded = await loadForPerson(caller, specId);
  if ('ok' in loaded) return loaded;
  if (loaded.spec.workspaceId !== req.workspaceId) return fail(400, INVALID, { code: 'request_invalid' });
  if (loaded.spec.version !== req.expectedVersion || loaded.spec.status !== req.status) {
    return fail(409, `The spec changed since this was asked for: it is now ${loaded.spec.status}, at version ${loaded.spec.version}. Nothing was changed. Ask again if it still applies.`, { code: 'request_stale', currentVersion: loaded.spec.version });
  }
  return { ...loaded, req };
}

/**
 * A person confirms a retire or restore asked for from an OAuth session. Only a
 * dashboard session confirms; any bearer is a 403. A spec whose version or
 * status moved since the link was made is a 409 (`request_stale`) and nothing
 * changes (R-12). The change is recorded as the confirming person's.
 */
export async function confirmSpecStatusChange(caller: SpecCaller, specId: string, token: unknown): Promise<{ ok: true; spec: SpecRow } | SpecError> {
  if (caller.kind !== 'user') return fail(403, 'Confirm it on buildd.dev, signed in. A session token, API key or agent run cannot confirm it.');
  const read = await readStatusRequest(caller, specId, token);
  if ('ok' in read) return read;
  const { spec, personId, req } = read;
  let r: { ok: true; spec: SpecRow } | SpecError;
  if (req.op === 'retire') {
    const target = await retireTarget(spec, req.supersededBy);
    r = 'ok' in target ? target : await writeStatus(spec, personId, target.next, req.reason, target.newValue);
    if (r.ok) openRepoPrAfter(spec);
  } else {
    const back = await restoreTarget(spec);
    r = typeof back !== 'string' ? back : await writeStatus(spec, personId, back, req.reason, { status: back });
  }
  return !r.ok && r.status === 409 ? { ...r, code: 'request_stale' } : r;
}

/** What the confirm page (/app/specs/[specId]/retire) shows; it only reads. */
export type StatusRequestView =
  | { state: 'invalid' | 'expired' | 'not_found' | 'not_approver' }
  | { state: 'stale'; title: string; status: string }
  | { state: 'ready'; title: string; op: 'retire' | 'restore'; from: string; to: string; reason: string; supersededBy: { id: string; title: string } | null };

export async function statusRequestView(userId: string, specId: string, token: string | null | undefined): Promise<StatusRequestView> {
  const caller = { kind: 'user' as const, userId };
  const read = await readStatusRequest(caller, specId, token);
  if ('ok' in read) {
    if (read.code === 'request_expired') return { state: 'expired' };
    if (read.status === 404) return { state: 'not_found' };
    if (read.status === 403) return { state: 'not_approver' };
    if (read.code === 'request_stale') {
      const [s] = await db.select({ title: specs.title, status: specs.status }).from(specs).where(eq(specs.id, specId)).limit(1);
      return s ? { state: 'stale', title: s.title, status: s.status } : { state: 'not_found' };
    }
    return { state: 'invalid' };
  }
  const { spec, req } = read;
  let to: string;
  let supersededBy: { id: string; title: string } | null = null;
  if (req.op === 'retire') {
    const target = await retireTarget(spec, req.supersededBy);
    if ('ok' in target) return { state: 'stale', title: spec.title, status: spec.status };
    to = target.next;
    if (req.supersededBy) {
      const [r] = await db.select({ id: specs.id, title: specs.title }).from(specs).where(eq(specs.id, req.supersededBy)).limit(1);
      supersededBy = r ?? null;
    }
  } else {
    const back = await restoreTarget(spec);
    if (typeof back !== 'string') return { state: 'stale', title: spec.title, status: spec.status };
    to = back;
  }
  return { state: 'ready', title: spec.title, op: req.op, from: spec.status, to, reason: req.reason, supersededBy };
}

/** Why and by what a spec is retired, for its page; null when it is not. */
export async function specRetirement(specId: string): Promise<RetirementView | null> {
  if (!isUuid(specId)) return null;
  const [spec] = await db.select({ id: specs.id, status: specs.status }).from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec) return null;
  const last = await lastRetirement(spec);
  if (!last) return null;
  const nv = (last.newValue ?? {}) as { supersededBy?: unknown };
  const repoFile = repoFileOf(last.newValue);
  let supersededBy: RetirementView['supersededBy'] = null;
  if (typeof nv.supersededBy === 'string' && isUuid(nv.supersededBy)) {
    const [r] = await db.select({ id: specs.id, title: specs.title }).from(specs).where(eq(specs.id, nv.supersededBy)).limit(1);
    supersededBy = r ?? null;
  }
  return {
    status: spec.status as RetirementView['status'], reason: last.reason, supersededBy, by: last.changedBy, at: last.createdAt.toISOString(),
    repoFile, repoLine: retiredRepoLine(repoFile),
  };
}

/**
 * For a live spec whose last retirement reached its repo file: the page's note
 * that restoring left the file as it is (R-80). `status`: the spec's, when the
 * caller has read it already.
 */
export async function specRestoredRepoFile(specId: string, status?: string): Promise<string | null> {
  if (!isUuid(specId)) return null;
  const now = status ?? (await db.select({ status: specs.status }).from(specs).where(eq(specs.id, specId)).limit(1))[0]?.status;
  if (!now || isRetired(now)) return null;
  const row = await retirementRow(specId);
  return row ? restoredRepoNote(repoFileOf(row.newValue)) : null;
}
