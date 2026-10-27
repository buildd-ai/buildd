import { db } from '@buildd/core/db';
import { specRevisions, specs, workspaces } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { requestingPerson } from '@/lib/request-person';
import { holdsInWorkspace } from '@/lib/team-access';
import { appBaseUrl } from '@/lib/app-url';
import { fail, importedRefusal, reach, type SpecCaller, type SpecError, type SpecRevisionRow, type SpecRow } from './store';
import { signSpecApprovalRequest, specApprovalConfirmPath, verifySpecApprovalRequest } from './approval-request';
import { emit } from '@/lib/core-emit';
import { approvedAttachmentsSql } from './attachment-pins';
import { after } from 'next/server';
import { defaultRetireChoice, liveReplaced, parseRetireChoice, type RetireChoice } from './replaces';
import type { ApprovalRetirement } from './retire';
import type { SpecApprovalRecord, SpecGateResult } from '@buildd/core/db/schema';
import { users } from '@buildd/core/db/schema';
import { specApprovalInboxUrl, specPageUrl } from './approval-inbox';
import { checkSpecPresence } from '@/lib/passkeys/guard';

/** What a request tells the approver: the confirm page's address and the gate's verdict. */
export interface ApprovalRequestedNotice {
  workspaceId: string;
  title: string;
  revision: number;
  confirmUrl: string;
  gate: SpecGateResult;
}

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
 *
 * Presence (spec b7fc9316 R-20): when the workspace's team requires a passkey,
 * the stamp from a dashboard session also needs a passkey assertion over this
 * exact revision, version and content hash (lib/passkeys/guard.ts). It is
 * the last check before the stamp, on every path that stamps: the spec page,
 * an inbox row, a confirm link and an import confirm.
 */

/**
 * Work that follows an approval but is not part of it. Indexing the approved
 * text into recall and the graph is dozens of sequential round trips plus an
 * embedding call, so it runs after the response (`after()`), never while a
 * person waits on the Approve button. Overridable for tests.
 */
export const specApprovalDeps: { afterResponse: (task: () => Promise<unknown>) => void; notify: (n: ApprovalRequestedNotice) => Promise<void> } = {
  notify: n => emit({
    type: 'spec.approval_requested', workspaceId: n.workspaceId, title: n.title, revision: n.revision,
    confirmUrl: n.confirmUrl, warnings: n.gate.warnings.length,
  }),
  afterResponse: task => {
    const run = () => task().catch(() => {});
    // Outside a request (a script, a test) there is no response to wait for.
    try { after(run); } catch { void run(); }
  },
};

/**
 * The approving person's user id, or null when the caller may not approve here.
 * `reached`: the caller's own read access, when the caller already asked for it
 * and the caller is that person (a dashboard session), so it is not asked twice.
 */
export async function specApprover(caller: SpecCaller, workspaceId: string, reached?: Promise<boolean>): Promise<string | null> {
  const personId = caller.kind === 'user' ? caller.userId : requestingPerson(null, caller.account);
  if (!personId) return null;
  if (await holdsInWorkspace(personId, workspaceId, 'approve_specs')) return personId;
  // A delegated approver is a member of the team the workspace names.
  const member = caller.kind === 'user' && reached ? reached : reach({ kind: 'user', userId: personId }, workspaceId, false);
  if (!(await member)) return null;
  const [ws] = await db.select({ gitConfig: workspaces.gitConfig }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const ids = ((ws?.gitConfig as { livingSpecs?: { approverUserIds?: unknown } } | null)?.livingSpecs?.approverUserIds);
  return Array.isArray(ids) && ids.includes(personId) ? personId : null;
}

/**
 * Read access and the approver check, asked together: neon-http pays a round
 * trip per statement, and neither needs the other's answer. Not reaching the
 * workspace still wins (a 404 before a 403), so nothing leaks about a
 * workspace the caller cannot see.
 */
async function reachAndApprover(caller: SpecCaller, workspaceId: string): Promise<{ reached: boolean; approver: string | null }> {
  const reached = reach(caller, workspaceId, false);
  const [ok, approver] = await Promise.all([reached, specApprover(caller, workspaceId, reached)]);
  return { reached: ok, approver: ok ? approver : null };
}

const NOT_A_PERSON = 'Approving a spec is a person\'s decision: an owner or admin of this team, or a delegated approver, from their own session. An agent run or API key cannot submit or approve.';
/** The refusal, with where a person does it (R-8): the spec's page and the inbox of everything waiting. */
const notAPerson = (specId: string) => `${NOT_A_PERSON} A person approves it on buildd.dev: ${specPageUrl(specId)}, or with everything waiting for approval at ${specApprovalInboxUrl()}.`;

async function loadForDecision(caller: SpecCaller, specId: string, expectedVersion: unknown): Promise<{ spec: SpecRow; approver: string } | SpecError> {
  if (!isUuid(specId)) return fail(404, 'Spec not found');
  if (!Number.isInteger(expectedVersion)) return fail(400, 'expectedVersion (the spec version you read) is required');
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec) return fail(404, 'Spec not found');
  const { reached, approver } = await reachAndApprover(caller, spec.workspaceId);
  if (!reached) return fail(404, 'Spec not found');
  if (!approver) return fail(403, notAPerson(specId));
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
export interface PendingSpecApproval {
  confirmUrl: string; revision: number; expiresAt: string;
  /** The gate's result: it passed, and may carry warnings. */
  gate: SpecGateResult;
  /** Who the confirmation was sent to. */
  sentTo: string;
  /** Everything waiting on a person's approval, this one among them (R-8). */
  inboxUrl: string;
}

/** The shortest reason a person gives to override a gate refusal. */
export const MIN_OVERRIDE_REASON = 10;
export const MAX_OVERRIDE_REASON = 500;

export async function approveSpecRevision(caller: SpecCaller, specId: string, input: {
  revision: unknown; expectedVersion: unknown; via?: unknown;
  /**
   * R-77: which of the specs the revision replaces to supersede with this
   * approval, as ids or { specId, expectedVersion } (the version read; a spec
   * that moved since is reported stale and the approval stands). Omitted: all
   * of them, the default choice; [] approves only.
   */
  retire?: unknown;
  /** A passkey assertion, when the team requires one (R-20); ignored otherwise. */
  presence?: unknown;
}, opts: {
  /** How the approval is recorded; a person's own press in the dashboard when absent. */
  record?: SpecApprovalRecord;
  /**
   * A person confirming an import (§18, R-19, ./import.ts), which has checked
   * the repo file is unchanged since the imported commit. The confirmation is
   * recorded on the spec in the approving statement. Without it, an imported
   * spec is refused: its file may have moved, and only confirmation checks.
   */
  importConfirmation?: { note: string };
  /** The caller already passed the presence check for a batch that holds this approval (an import confirm). */
  presenceChecked?: boolean;
} = {}): Promise<{ ok: true; spec: SpecRow; revision: SpecRevisionRow; retirements: ApprovalRetirement[] } | { ok: true; spec: SpecRow; pending: PendingSpecApproval } | SpecError> {
  if (!Number.isInteger(input.revision)) return fail(400, 'revision (the spec revision you read and are approving) is required');
  const loaded = await loadForDecision(caller, specId, input.expectedVersion);
  if ('ok' in loaded) return loaded;
  const { spec, approver } = loaded;
  const n = input.revision as number;
  if (n !== spec.headRevision) return fail(409, `Revision ${n} is not the head (revision ${spec.headRevision}); only the head is approved. Read it, then approve it.`, { currentVersion: spec.version });
  if (spec.approvedRevision === n) return fail(409, `Revision ${n} is already approved`, { currentVersion: spec.version });
  if (!opts.importConfirmation) {
    const refused = importedRefusal(spec);
    if (refused) return refused;
  } else if (spec.repoSource?.state !== 'imported' || spec.repoSource.revision !== n) {
    return fail(409, 'This spec has no imported revision waiting for confirmation', { code: 'not_imported' });
  }

  const [rev] = await db.select({ contentHash: specRevisions.contentHash, replaces: specRevisions.replaces }).from(specRevisions)
    .where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, n))).limit(1);
  if (!rev) return fail(404, `Revision ${n} not found`);
  // R-77: the replaced specs to supersede, each at the version read (now, when the caller named none).
  const live = await liveReplaced(spec.workspaceId, rev.replaces);
  let choice: RetireChoice;
  if (input.retire === undefined) choice = defaultRetireChoice(live);
  else {
    const parsed = parseRetireChoice(input.retire, rev.replaces ?? []);
    if ('error' in parsed) return fail(400, parsed.error);
    choice = parsed.map((c) => ({ specId: c.specId, expectedVersion: c.expectedVersion ?? live.find((r) => r.id === c.specId)?.version }));
  }

  if (caller.kind === 'account') {
    // A bearer session: the person's own, but maybe driven by an agent. Ask, don't
    // approve. The link carries the retire choice, at the versions read now.
    // The quality gate comes before anyone is asked.
    const { runApprovalGate } = await import('./approval-gate');
    const { gate } = await runApprovalGate(spec, n);
    if (!gate.passed) {
      return fail(409, `Not sent for approval: the revision fails the quality gate.\n${gate.refusals.map((r) => `- ${r.message}`).join('\n')}\nFix these in a new revision, then ask again.`, { code: 'gate_refused', gate, currentVersion: spec.version });
    }
    const now = Date.now();
    const via = input.via === 'chat' ? 'chat' : 'mcp';
    const token = signSpecApprovalRequest({ specId, workspaceId: spec.workspaceId, revision: n, expectedVersion: spec.version, contentHash: rev.contentHash, requestedBy: approver, via, retire: choice }, now);
    if (!token) return fail(502, 'Approval links are not configured on this deployment. Approve from buildd.dev.');
    const verdict = verifySpecApprovalRequest(token, now);
    const expiresAt = new Date(verdict.ok ? verdict.payload.exp : now).toISOString();
    const confirmUrl = `${appBaseUrl()}${specApprovalConfirmPath(specId, token)}`;
    // One notification per request: it is how the confirm page reaches the person.
    const [who] = await db.select({ name: users.name }).from(users).where(eq(users.id, approver)).limit(1);
    await specApprovalDeps.notify({ workspaceId: spec.workspaceId, title: spec.title, revision: n, confirmUrl, gate }).catch(() => {});
    return { ok: true, spec, pending: { confirmUrl, revision: n, expiresAt, gate, sentTo: who?.name?.trim() || 'you', inboxUrl: specApprovalInboxUrl() } };
  }

  // R-20, last before the stamp: a passkey over exactly what the stamp below is pinned to.
  if (!opts.presenceChecked) {
    const refused = await checkSpecPresence(approver, spec.workspaceId, { op: 'approve', specId, revision: n, version: spec.version, contentHash: rev.contentHash }, input.presence);
    if (refused) return { ...refused, currentVersion: spec.version };
  }

  const label = `user:${approver}`;
  const recordJson = JSON.stringify(opts.record ?? { via: 'dashboard', gate: null } satisfies SpecApprovalRecord);
  // The binding attachments (§21) are recorded in the same statement as the
  // stamp, at their artifact revisions now, beside the design the revision pins.
  // A confirmed import records who, when and what, with the approval (R-19), and buildd is the source from then on.
  const confirmJson = opts.importConfirmation
    ? JSON.stringify({ state: 'confirmed', confirmedBy: label, note: opts.importConfirmation.note })
    : null;
  const rows = await db.execute(sql`
    WITH stamp AS (
      UPDATE spec_revisions SET approved_by = ${label}, approved_at = now(), approval = ${recordJson}::jsonb,
        approved_attachments = ${approvedAttachmentsSql(specId, n)}
      WHERE spec_id = ${specId}::uuid AND revision = ${n} AND approved_at IS NULL
        AND EXISTS (SELECT 1 FROM specs WHERE id = ${specId}::uuid AND version = ${spec.version} AND head_revision = ${n}
          AND (${confirmJson}::jsonb IS NULL OR repo_source->>'state' = 'imported'))
      RETURNING revision
    )
    UPDATE specs SET approved_revision = ${n}, status = 'approved', version = version + 1, updated_at = now(),
      repo_source = CASE WHEN ${confirmJson}::jsonb IS NULL THEN repo_source
        ELSE repo_source || ${confirmJson}::jsonb || jsonb_build_object('confirmedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END
    WHERE id = ${specId}::uuid AND version = ${spec.version} AND head_revision = ${n} AND EXISTS (SELECT 1 FROM stamp)
      AND (${confirmJson}::jsonb IS NULL OR repo_source->>'state' = 'imported')
    RETURNING id`);
  if (rowsOf(rows).length === 0) return conflictNow(specId);
  const [[after], [revision]] = await Promise.all([
    db.select().from(specs).where(eq(specs.id, specId)).limit(1),
    db.select().from(specRevisions).where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, n))).limit(1),
  ]);
  // Modules react (the knowledge index), after the response: the approval has
  // committed, and emit never throws, so nothing there undoes it.
  const workspaceId = after.workspaceId;
  // A native-sourced spec (§18, R-15) also gets its repo copy's PR written; a
  // workspace that has not opted in gets nothing (fileSpecRepoCopy returns null, AC-78).
  // After the index, in the same task: emit never throws, and the copy reads
  // nothing the index writes, so the order only keeps one task per approval.
  // Work built ahead of approval (§20, R-39): every provisional pin on this
  // spec re-pins to n and is re-graded there, after the index (emit never
  // throws) and before the repo copy, on its own: a repo copy that fails must
  // not leave shipped work ungraded.
  specApprovalDeps.afterResponse(async () => {
    await emit({ type: 'spec.approved', specId, workspaceId, revision: n });
    const { regradeProvisionalPins } = await import('./provisional');
    await regradeProvisionalPins(specId, n).catch((e) => console.error(`[spec-approval] provisional re-grade for ${specId} failed:`, e));
    const { fileSpecRepoCopy, redecidePublication } = await import('./repo-copy');
    await fileSpecRepoCopy(specId);
    // Slice 14, R-70: a product spec carries the publication policy; a new
    // approved revision of it re-decides every spec in the workspace.
    if (after.scope === 'product') await redecidePublication(workspaceId);
  });
  // R-77: then each replaced spec the person left checked, superseded by this one.
  // The approval has committed: a replaced spec that moved is reported stale, never undoes it.
  const retirements = choice.length
    ? await (await import('./retire')).supersedeOnApproval(approver, { id: specId, title: after.title, workspaceId, revision: n }, choice)
    : [];
  return { ok: true, spec: after, revision, retirements };
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
export async function confirmSpecApproval(caller: SpecCaller, specId: string, token: unknown, opts: {
  overrideReason?: unknown;
  /** The person's own retire choice on the confirm page; omitted, the one the link carries (R-77). */
  retire?: unknown;
  /** A passkey assertion, when the team requires one (R-20). */
  presence?: unknown;
} = {}): Promise<{ ok: true; already: boolean; spec: SpecRow; revision: SpecRevisionRow; retirements: ApprovalRetirement[] } | SpecError> {
  if (caller.kind !== 'user') return fail(403, 'Confirm the approval on buildd.dev, signed in. An agent session cannot confirm it.');
  const v = verifySpecApprovalRequest(typeof token === 'string' ? token : null);
  if (!v.ok) {
    return v.reason === 'expired'
      ? fail(400, 'This approval link has expired. Ask for a new one.', { code: 'request_expired' })
      : fail(400, 'This approval link is not valid.', { code: 'request_invalid' });
  }
  const req = v.payload;
  if (!isUuid(specId) || req.specId !== specId) return fail(400, 'This approval link is not valid.', { code: 'request_invalid' });
  return approvePinned(caller, specId, req, {
    via: req.via ?? 'mcp', staleCode: 'request_stale', workspaceId: req.workspaceId,
    staleText: 'The spec changed since this approval was asked for. Ask for a new link.', overrideReason: opts.overrideReason,
    retire: opts.retire !== undefined ? opts.retire : req.retire, presence: opts.presence,
  });
}

/**
 * Approve one row of the Awaiting your approval inbox (spec b7fc9316 R-3 to
 * R-6): the revision, version and content hash the page rendered, re-checked
 * now, from a dashboard session and nothing else. Any bearer, the person's own
 * OAuth session included, is a 403 (the route also refuses any request that
 * carries an Authorization header). Anything that moved since the page loaded
 * is a 409 with code `stale` and approves nothing. One row, one revision: there
 * is no batch form.
 */
export async function approveFromInbox(caller: SpecCaller, specId: string, input: { revision?: unknown; expectedVersion?: unknown; contentHash?: unknown; overrideReason?: unknown; retire?: unknown; presence?: unknown }): Promise<{ ok: true; already: boolean; spec: SpecRow; revision: SpecRevisionRow; retirements: ApprovalRetirement[] } | SpecError> {
  if (caller.kind !== 'user') return fail(403, 'Approve on buildd.dev, signed in, with a click. A session token, API key or agent run cannot approve.');
  if (!isUuid(specId)) return fail(404, 'Spec not found');
  if (!Number.isInteger(input.revision) || !Number.isInteger(input.expectedVersion)) return fail(400, 'revision and expectedVersion (as the page showed them) are required');
  if (typeof input.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.contentHash)) return fail(400, 'contentHash (the sha256 of the revision the page showed) is required');
  return approvePinned(caller, specId, { revision: input.revision as number, expectedVersion: input.expectedVersion as number, contentHash: input.contentHash }, {
    via: 'dashboard', staleCode: 'stale', staleText: 'The spec changed since this page loaded. It now shows the latest revision; read it, then approve.', overrideReason: input.overrideReason, retire: input.retire, presence: input.presence,
  });
}

/**
 * The checks every pinned approval shares (a confirm link, an inbox row): the
 * person may approve here, the revision's body is the one that was shown, the
 * spec has not moved, and the quality gate passes now or the person gives a
 * reason, which is recorded. Then the same atomic stamp as any approval.
 */
async function approvePinned(
  caller: Extract<SpecCaller, { kind: 'user' }>,
  specId: string,
  pin: { revision: number; expectedVersion: number; contentHash: string },
  opts: {
    via: SpecApprovalRecord['via']; staleCode: string; staleText: string; overrideReason?: unknown; workspaceId?: string;
    /** R-77: which replaced specs to supersede; omitted, all of them (the default choice). */
    retire?: unknown;
    /** A passkey assertion, checked by the stamp when the team requires one (R-20). */
    presence?: unknown;
  },
): Promise<{ ok: true; already: boolean; spec: SpecRow; revision: SpecRevisionRow; retirements: ApprovalRetirement[] } | SpecError> {
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec) return fail(404, 'Spec not found');
  const { reached, approver } = await reachAndApprover(caller, spec.workspaceId);
  if (!reached) return fail(404, 'Spec not found');
  if (opts.workspaceId && spec.workspaceId !== opts.workspaceId) return fail(400, 'This approval link is not valid.', { code: 'request_invalid' });
  if (!approver) return fail(403, notAPerson(specId));
  const [rev] = await db.select().from(specRevisions)
    .where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, pin.revision))).limit(1);
  if (!rev || rev.contentHash !== pin.contentHash) return fail(409, opts.staleText, { code: opts.staleCode, currentVersion: spec.version });
  if (spec.approvedRevision === pin.revision && rev.approvedAt) return { ok: true, already: true, spec, revision: rev, retirements: [] };
  if (spec.version !== pin.expectedVersion || spec.headRevision !== pin.revision) {
    return fail(409, opts.staleText, { code: opts.staleCode, currentVersion: spec.version });
  }
  // Asked again now: a pin or a body may have moved since the page or the
  // request. A refusal stands unless the person gives a reason, which is recorded.
  const { runApprovalGate } = await import('./approval-gate');
  const { gate } = await runApprovalGate(spec, pin.revision);
  const reason = typeof opts.overrideReason === 'string' ? opts.overrideReason.trim() : '';
  if (!gate.passed) {
    if (reason.length < MIN_OVERRIDE_REASON) {
      return fail(409, `The quality gate refuses this revision:\n${gate.refusals.map((x) => `- ${x.message}`).join('\n')}\nTo approve anyway, give a reason (at least ${MIN_OVERRIDE_REASON} characters).`, { code: 'gate_refused', gate, currentVersion: spec.version });
    }
    if (reason.length > MAX_OVERRIDE_REASON) return fail(400, `The reason is at most ${MAX_OVERRIDE_REASON} characters.`);
  }
  const record: SpecApprovalRecord = { via: opts.via, gate, ...(!gate.passed ? { overrideReason: reason } : {}) };
  const r = await approveSpecRevision(caller, specId, { revision: pin.revision, expectedVersion: pin.expectedVersion, retire: opts.retire, presence: opts.presence }, { record });
  if (!r.ok) return r.status === 409 && !r.presence ? { ...r, code: opts.staleCode } : r;
  if ('pending' in r) return fail(403, notAPerson(specId));
  return { ok: true, already: false, spec: r.spec, revision: r.revision, retirements: r.retirements };
}
