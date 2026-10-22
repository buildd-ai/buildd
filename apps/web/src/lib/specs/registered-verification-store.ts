import { randomUUID } from 'node:crypto';
import { db } from '@buildd/core/db';
import { artifactRevisions, artifacts, missions, specOutcomeVerdicts, systemCache, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';
import { isSurfaceAuditTask } from '@buildd/core/surface-audit';
import { parseSurfaceEvidence, UI_VERIFICATION_PROFILE, UI_VERIFICATION_PROFILE_VERSION, type SurfaceEvidence } from '@buildd/core/ui-verification';
import { uiCopyKind } from '@buildd/core/decision-kind-ui-copy';
import { criterionVerifications } from '@buildd/spec-contract/verification-bindings';
import { specCriteria } from '@buildd/spec-contract/requirements';
import { inScope } from '@buildd/spec-contract/scope';
import { isUuid } from '@/lib/uuid';
import { isAncestor } from '@/lib/integration-refresh';
import { auditorRefusal, ownShots } from '@/lib/visual-audit-spec-verdict';
import { executeUiVerification } from './ui-verification-decision';
import { currentPrHeadSha, recordRegisteredVerdict } from './outcome';
import { recordMissionVerdictServer, resolveMissionCheckTarget } from './mission-outcome';
import { readPinnedSpecRevision } from './pin';
import { linkedRepo } from './repo-source';
import { livingSpecCriteriaOf } from './selected-scope';
import { criterionHashes } from './criteria';
import {
  MAX_REGISTERED_SURFACES, dispatchRegisteredVerification, sha256,
  type RegisteredVerification, type RegisteredVerificationDeps as Deps,
  type Collection, type CollectedSurface, type RefusedSurface, type RegisteredRun, type RegisteredSubject, type RegisteredVerificationDeps,
} from './registered-verification';

/**
 * The production store behind ./registered-verification.ts.
 *
 * Subject: the task's own pin (a PR), or a platform final verification task's
 * mission selection, with its scope and waivers; the body is the pinned
 * immutable revision (its hash is checked by readPinnedSpecRevision); the head
 * is the kernel-observed PR head or the mission's resolved integrated target.
 *
 * Evidence: a `data` artifact holding SurfaceEvidence JSON, admitted only when
 *  - it is in the subject's workspace (cross_workspace);
 *  - a worker of a mission [surface audit] uploaded it, by the visual audit's
 *    rule (auditorRefusal): filed by the platform or a person, in the subject's
 *    mission, reviewing the subject, never the subject or a task under it;
 *  - its current revision was written by that run (no person or other account
 *    edited it afterwards);
 *  - its own provenance names the auditor (collector_mismatch otherwise);
 *  - it captured the current target (the PR head, or a commit containing it for
 *    a task; exactly the integrated target for a mission), else stale_capture;
 *  - any screenshot it cites is one that run uploaded (foreign_screenshot).
 * The capture's metadata (e.g. metadata.qa) is never read: only lineage and body.
 *
 * Reservations are rows in system_cache, taken with one atomic upsert that
 * succeeds only when the key is free or its lease has lapsed. The cache is
 * spec_outcome_verdicts itself: a stored row with the same run key.
 */

export const REGISTERED_LEASE_MS = 5 * 60_000;
const RESERVATION_PREFIX = 'registered-verification:';
const MAX_CANDIDATES = 50;
const SHA40 = /^[0-9a-f]{40}$/i;

type SpecError = { ok: false; status: number; error: string };
export interface RegisteredStoreExternals {
  prHead: (taskId: string) => Promise<string | null>;
  missionTarget: (missionId: string) => Promise<{ headSha: string; branch: string } | null>;
  repo: (workspaceId: string) => Promise<{ fullName: string; installationId: number } | null>;
  contains: (installationId: number, repoFullName: string, ancestor: string, head: string) => Promise<boolean | null>;
  execute: typeof executeUiVerification;
  recordMission: (missionId: string, input: Parameters<typeof recordMissionVerdictServer>[1]) => Promise<{ ok: true; verdictId: string } | SpecError>;
  leaseMs: number;
}
type Api = NonNullable<Parameters<typeof resolveMissionCheckTarget>[1]>;

function externals(overrides: Partial<RegisteredStoreExternals> & { githubApi?: Api } = {}): RegisteredStoreExternals {
  const { githubApi: api, ...rest } = overrides;
  return {
    prHead: currentPrHeadSha,
    missionTarget: (missionId) => resolveMissionCheckTarget(missionId, ...(api ? [api] : [])),
    repo: linkedRepo,
    contains: (installationId, repoFullName, ancestor, head) => isAncestor(installationId, repoFullName, ancestor, head, ...(api ? [api] : [])),
    execute: executeUiVerification,
    // The mission recorder re-checks binding, author and that the commit is the current integrated target.
    recordMission: (missionId, input) => recordMissionVerdictServer(missionId, input, ...(api ? [api] : [])),
    leaseMs: REGISTERED_LEASE_MS,
    ...rest,
  };
}
const defaults = externals();

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

type AuditRow = {
  id: string; title: string; workspaceId: string; missionId: string | null; roleSlug: string | null;
  dependsOn: unknown; parentTaskId: string | null; createdByWorkerId: string | null;
};
export type AuditSubject =
  | { kind: 'task'; task: AuditRow }
  | { kind: 'mission'; missionId: string; workspaceId: string; finalTaskId: string };

/** Why `audit` may not supply evidence about `subject`, or null when it may. Pure. */
export function surfaceAuditorRefusal(audit: AuditRow, subject: AuditSubject): string | null {
  if (subject.kind === 'task') return auditorRefusal(audit, subject.task);
  if (audit.roleSlug !== VISUAL_AUDITOR_ROLE_SLUG || !isSurfaceAuditTask(audit.title)) return 'only a mission\'s [surface audit] supplies captures';
  if (audit.createdByWorkerId !== null) return 'this audit was filed by an agent; only an audit the platform or a person filed supplies captures';
  if (audit.id === subject.finalTaskId || audit.parentTaskId === subject.finalTaskId) return 'a task never grades its own work';
  if (audit.missionId !== subject.missionId || audit.workspaceId !== subject.workspaceId) return 'the audit is not in this mission';
  return null;
}

const auditColumns = {
  id: tasks.id, title: tasks.title, workspaceId: tasks.workspaceId, missionId: tasks.missionId, roleSlug: tasks.roleSlug,
  dependsOn: tasks.dependsOn, parentTaskId: tasks.parentTaskId, createdByWorkerId: tasks.createdByWorkerId,
};

async function loadSubject(taskId: string, ext: RegisteredStoreExternals): Promise<RegisteredSubject | { error: string }> {
  if (!isUuid(taskId)) return { error: 'not a task id' };
  const [task] = await db.select({ ...auditColumns, context: tasks.context, creationSource: tasks.creationSource, teamId: workspaces.teamId })
    .from(tasks).innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId)).where(eq(tasks.id, taskId)).limit(1);
  if (!task) return { error: 'task not found' };
  if (!task.teamId) return { error: 'the workspace belongs to no team' };
  const final = asRecord(asRecord(task.context)?.finalVerification);
  let pin = asRecord(asRecord(task.context)?.specSource);
  let missionId: string | undefined;
  let headSha: string | null;
  if (final) {
    if (task.creationSource !== 'orchestrator' || !task.missionId || final.missionId !== task.missionId) return { error: 'not a platform final verification' };
    const [mission] = await db.select({ workspaceId: missions.workspaceId, goalCriteria: missions.goalCriteria }).from(missions).where(eq(missions.id, task.missionId)).limit(1);
    const selected = livingSpecCriteriaOf(mission?.goalCriteria).find((c) => c.specRevisionId === final.specRevisionId);
    if (!selected || mission?.workspaceId !== task.workspaceId) return { error: 'the mission no longer selects this revision' };
    pin = { ...selected };
    missionId = task.missionId;
    headSha = (await ext.missionTarget(missionId))?.headSha ?? null;
  } else {
    headSha = await ext.prHead(task.id);
  }
  if (!pin || typeof pin.specRevisionId !== 'string') return { error: 'the task is not pinned to a Living Spec revision' };
  const read = await readPinnedSpecRevision(pin);
  if (!read.ok) return { error: read.reason };
  if (!headSha || !SHA40.test(headSha)) return { error: missionId ? 'the mission has no integrated target to verify' : 'the task has no PR head to verify' };
  const waived = new Set((Array.isArray(pin.waived) ? pin.waived : []).map((w) => asRecord(w)?.criterionId));
  const criterionIds = inScope(pin, specCriteria(read.body)).map((c) => c.id).filter((id) => !waived.has(id));
  return {
    kind: missionId ? 'mission' : 'task', taskId: task.id, subjectId: missionId ?? task.id, workspaceId: task.workspaceId, teamId: task.teamId,
    ...(missionId ? { missionId } : task.missionId ? { missionId: task.missionId } : {}),
    specRevisionId: pin.specRevisionId, headSha: headSha.toLowerCase(), body: read.body, criterionIds, criterionHashes: criterionHashes(read.body),
  };
}

type Candidate = { id: string; workspaceId: string | null; workerId: string | null; type: string; content: string | null; currentRevision: number };
const candidateColumns = {
  id: artifacts.id, workspaceId: artifacts.workspaceId, workerId: artifacts.workerId, type: artifacts.type,
  content: artifacts.content, currentRevision: artifacts.currentRevision,
};

const captureKey = (e: SurfaceEvidence) => `${e.subject.route}\u0000${e.subject.scenarioId}\u0000${e.subject.viewport}`;

async function admit(c: Candidate, s: RegisteredSubject, ext: RegisteredStoreExternals, explicit: boolean):
Promise<{ ok: true; surface: CollectedSurface; evidence: SurfaceEvidence; at: number } | { ok: false; refused: RefusedSurface | null } | { error: string }> {
  const refuse = (reason: string) => ({ ok: false as const, refused: { ref: c.id, reason } });
  if (c.workspaceId !== s.workspaceId) return refuse('cross_workspace');
  if (c.type !== 'data' || !c.workerId) return explicit ? refuse('not_a_capture') : { ok: false, refused: null };
  const [w] = await db.select({ taskId: workers.taskId, accountId: workers.accountId }).from(workers).where(eq(workers.id, c.workerId)).limit(1);
  const [audit] = w?.taskId ? await db.select(auditColumns).from(tasks).where(eq(tasks.id, w.taskId)).limit(1) : [];
  if (!audit) return refuse('no_audit_run');
  let subject: AuditSubject;
  if (s.kind === 'mission') {
    subject = { kind: 'mission', missionId: s.subjectId, workspaceId: s.workspaceId, finalTaskId: s.taskId };
  } else {
    const [t] = await db.select(auditColumns).from(tasks).where(eq(tasks.id, s.subjectId)).limit(1);
    if (!t) return { error: 'the task is gone' };
    subject = { kind: 'task', task: t };
  }
  // Searching (no named capture), an audit that does not review this subject is
  // simply not about it; its captures are skipped rather than reported.
  const reviews = subject.kind === 'mission' ? audit.missionId === subject.missionId
    : Array.isArray(audit.dependsOn) && audit.dependsOn.includes(subject.task.id);
  if (!explicit && !reviews) return { ok: false, refused: null };
  const refusal = surfaceAuditorRefusal(audit, subject);
  if (refusal) return refuse(refusal);

  // The body that counts is the current immutable revision, and only if the audit run wrote it.
  const [rev] = await db.select({ content: artifactRevisions.content, contentHash: artifactRevisions.contentHash, workerId: artifactRevisions.workerId, author: artifactRevisions.author, at: artifactRevisions.createdAt })
    .from(artifactRevisions).where(and(eq(artifactRevisions.artifactId, c.id), eq(artifactRevisions.revision, c.currentRevision))).limit(1);
  const ownAuthor = rev && (rev.author === null || (w.accountId !== null && rev.author === `account:${w.accountId}`));
  if (!rev || rev.workerId !== c.workerId || !ownAuthor || typeof rev.content !== 'string' || !rev.contentHash) return refuse('capture_not_written_by_audit_run');

  let raw: unknown;
  try { raw = JSON.parse(rev.content); } catch { return explicit ? refuse('not_a_capture') : { ok: false, refused: null }; }
  const shaped = asRecord(raw);
  if (!shaped || shaped.schemaVersion !== 1 || !asRecord(shaped.subject) || !asRecord(shaped.capture)) {
    return explicit ? refuse('not_a_capture') : { ok: false, refused: null };
  }
  const parsed = parseSurfaceEvidence(raw);
  if (!parsed.ok) return refuse(parsed.message);
  const e = parsed.features;
  if (e.provenance.collector !== 'visual_auditor') return refuse('collector_mismatch');

  const captureSha = e.subject.commitSha;
  if (captureSha !== s.headSha) {
    if (s.kind === 'mission') return refuse('stale_capture');
    const repo = await ext.repo(s.workspaceId);
    if (!repo) return refuse('stale_capture');
    const contains = await ext.contains(repo.installationId, repo.fullName, s.headSha, captureSha);
    if (contains === null) return { error: 'GitHub could not be reached to check the captured commit; nothing was recorded, try again' };
    if (!contains) return refuse('stale_capture');
  }
  const shot = e.capture.screenshotRef;
  if (shot !== undefined && (!isUuid(shot) || !(await ownShots(audit, [shot])))) return refuse('foreign_screenshot');

  return {
    ok: true, evidence: e, at: rev.at.getTime(),
    surface: {
      input: e, ref: `${c.id}:${rev.contentHash}`, fingerprint: sha256(e),
      scenario: { scenarioId: e.subject.scenarioId, viewport: e.subject.viewport },
      provenance: { artifactId: c.id, revision: c.currentRevision, auditTaskId: audit.id, captureSha },
    },
  };
}

async function collect(s: RegisteredSubject, evidenceRef: string | undefined, ext: RegisteredStoreExternals): Promise<Collection> {
  const admitted: CollectedSurface[] = [];
  const refused: RefusedSurface[] = [];
  let candidates: Candidate[];
  if (evidenceRef !== undefined) {
    if (!isUuid(evidenceRef)) return { admitted, refused: [{ ref: evidenceRef, reason: 'not_found' }] };
    candidates = await db.select(candidateColumns).from(artifacts).where(eq(artifacts.id, evidenceRef)).limit(1);
    if (!candidates.length) return { admitted, refused: [{ ref: evidenceRef, reason: 'not_found' }] };
  } else {
    if (!s.missionId) return { admitted, refused };
    // Only a mission [surface audit] supplies captures: look only at its runs' data artifacts.
    candidates = await db.select(candidateColumns).from(artifacts)
      .innerJoin(workers, eq(workers.id, artifacts.workerId))
      .innerJoin(tasks, eq(tasks.id, workers.taskId))
      .where(and(eq(artifacts.workspaceId, s.workspaceId), eq(artifacts.type, 'data'), eq(tasks.missionId, s.missionId), eq(tasks.roleSlug, VISUAL_AUDITOR_ROLE_SLUG)))
      .orderBy(desc(artifacts.updatedAt)).limit(MAX_CANDIDATES);
  }
  // The newest capture of each route, scenario and viewport stands for it.
  const newest = new Map<string, { surface: CollectedSurface; at: number }>();
  for (const c of candidates) {
    const r = await admit(c, s, ext, evidenceRef !== undefined);
    if ('error' in r) return { admitted: [], refused, error: r.error };
    if (!r.ok) { if (r.refused) refused.push(r.refused); continue; }
    const key = captureKey(r.evidence);
    const held = newest.get(key);
    if (!held || held.at < r.at) newest.set(key, { surface: r.surface, at: r.at });
  }
  admitted.push(...[...newest.values()].map((x) => x.surface));
  return { admitted: admitted.slice(0, MAX_REGISTERED_SURFACES + 1), refused };
}

const subjectColumn = (s: RegisteredSubject) => (s.kind === 'mission' ? eq(specOutcomeVerdicts.missionId, s.subjectId) : eq(specOutcomeVerdicts.taskId, s.subjectId));

async function cached(s: RegisteredSubject, runKey: string) {
  const [hit] = await db.select({ id: specOutcomeVerdicts.id, criterionId: specOutcomeVerdicts.criterionId, evidence: specOutcomeVerdicts.evidence })
    .from(specOutcomeVerdicts)
    .where(and(eq(specOutcomeVerdicts.workspaceId, s.workspaceId), subjectColumn(s), eq(specOutcomeVerdicts.specRevisionId, s.specRevisionId), sql`${specOutcomeVerdicts.evidence}->>'runKey' = ${runKey}`))
    .orderBy(desc(specOutcomeVerdicts.createdAt)).limit(1);
  const run = asRecord(hit?.evidence?.run) as RegisteredRun | null;
  if (!hit || !run || run.runKey !== runKey) return null;
  const [latest] = await db.select({ id: specOutcomeVerdicts.id }).from(specOutcomeVerdicts)
    .where(and(subjectColumn(s), eq(specOutcomeVerdicts.specRevisionId, s.specRevisionId), eq(specOutcomeVerdicts.criterionId, hit.criterionId),
      sql`${specOutcomeVerdicts.evidence}->>'bindingFingerprint' = ${run.bindingFingerprint}`))
    .orderBy(desc(specOutcomeVerdicts.createdAt)).limit(1);
  return { verdictId: hit.id, run, current: latest?.id === hit.id };
}

const rowsOf = (r: unknown) => ((r as { rows?: Array<Record<string, unknown>> })?.rows ?? (Array.isArray(r) ? r : [])) as Array<Record<string, unknown>>;

async function reserve(s: RegisteredSubject, runKey: string, leaseMs: number) {
  const owner = randomUUID();
  const value = JSON.stringify({ owner, subject: `${s.kind}:${s.subjectId}`, workspaceId: s.workspaceId });
  const taken = rowsOf(await db.execute(sql`
    INSERT INTO ${systemCache} (key, value, updated_at, expires_at)
    VALUES (${RESERVATION_PREFIX + runKey}, ${value}::jsonb, now(), now() + make_interval(secs => ${leaseMs / 1000}))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value || '{"recovered":true}'::jsonb, updated_at = now(), expires_at = EXCLUDED.expires_at
    WHERE ${systemCache.expiresAt} IS NOT NULL AND ${systemCache.expiresAt} < now()
    RETURNING value
  `));
  const v = asRecord(taken[0]?.value);
  return v?.owner === owner ? { owner, recovered: v.recovered === true } : null;
}

async function release(runKey: string, owner: string) {
  await db.delete(systemCache).where(and(eq(systemCache.key, RESERVATION_PREFIX + runKey), sql`${systemCache.value}->>'owner' = ${owner}`));
}

async function holds(runKey: string, owner: string): Promise<boolean> {
  const [row] = await db.select({ key: systemCache.key }).from(systemCache)
    .where(and(eq(systemCache.key, RESERVATION_PREFIX + runKey), sql`${systemCache.value}->>'owner' = ${owner}`, sql`${systemCache.expiresAt} > now()`)).limit(1);
  return !!row;
}

async function record(
  s: RegisteredSubject, run: RegisteredRun, surfaces: readonly CollectedSurface[], lease: { owner: string; runKey: string } | undefined, ext: RegisteredStoreExternals,
): Promise<{ ok: true; verdictId: string } | { ok: false; reason: string }> {
  // Re-resolve everything the run depended on: a moved head, re-pinned task or
  // edited capture means the run judged something that is no longer current.
  const now = await loadSubject(s.taskId, ext);
  if ('error' in now) return { ok: false, reason: now.error };
  if (now.specRevisionId !== s.specRevisionId || now.headSha !== s.headSha || now.subjectId !== s.subjectId) return { ok: false, reason: 'the verification target moved while it ran' };
  if (now.criterionHashes.get(run.criterionId) !== s.criterionHashes.get(run.criterionId) || !now.criterionIds.includes(run.criterionId)) return { ok: false, reason: 'the criterion moved while it ran' };
  if (!criterionVerifications(now.body).some((b) => b.criterionId === run.criterionId && b.fingerprint === run.bindingFingerprint)) return { ok: false, reason: 'the binding moved while it ran' };
  for (const e of surfaces) {
    const [a] = await db.select({ currentRevision: artifacts.currentRevision }).from(artifacts).where(eq(artifacts.id, e.provenance.artifactId)).limit(1);
    if (a?.currentRevision !== e.provenance.revision) return { ok: false, reason: 'a capture changed while it was being verified' };
  }
  if (lease && !(await holds(lease.runKey, lease.owner))) return { ok: false, reason: 'the reservation lapsed and another run took it over' };

  const evidence: Record<string, unknown> = {
    kind: 'registered', bindingId: run.bindingId, bindingFingerprint: run.bindingFingerprint, method: run.method,
    runKey: run.runKey, evaluatorVersion: run.evaluatorVersion, inputFingerprint: run.inputFingerprint,
    ...(run.observed ? { observed: run.observed } : {}),
    decisionRecordIds: run.decisionRecordIds.slice(0, 32),
    evidenceRefs: run.evidenceRefs,
    captures: surfaces.map((e) => e.provenance),
    refs: surfaces.map((e) => ({ kind: 'capture', ref: e.provenance.artifactId })),
    inspected: ['text', 'actions', 'state'],
    ...(run.replayOf ? { replayOf: run.replayOf } : {}),
    ...(run.recoveredReservation ? { recoveredReservation: true } : {}),
    run: { ...run, receipts: run.receipts.slice(0, 16) },
  };
  const input = { specRevisionId: s.specRevisionId, criterionId: run.criterionId, verdict: run.verdict, headSha: s.headSha, recordedBy: run.recordedBy, evidence };
  const r = s.kind === 'mission'
    ? await ext.recordMission(s.subjectId, input)
    : await recordRegisteredVerdict(s.subjectId, input, ext.prHead);
  return r.ok ? { ok: true, verdictId: r.verdictId } : { ok: false, reason: r.error };
}

export function createRegisteredVerificationDeps(overrides: Partial<RegisteredStoreExternals> & { githubApi?: Api } = {}): RegisteredVerificationDeps {
  const ext = externals(overrides);
  return {
    load: (taskId) => loadSubject(taskId, ext),
    collect: (s, evidenceRef) => collect(s, evidenceRef, ext),
    evaluator: async (id) => id === 'ui.actions_match_state'
      ? { key: `${id}@1:${UI_VERIFICATION_PROFILE}@${UI_VERIFICATION_PROFILE_VERSION}:deterministic`, cacheable: true }
      // The broker resolves team policy, route and measurements on every call; until that
      // effective identity can be proven unchanged, a model judgment is never replayed.
      : { key: `${id}@1:${uiCopyKind.kind}:${uiCopyKind.policyVersion}:${uiCopyKind.promptFingerprint}`, cacheable: false },
    cached,
    reserve: (s, runKey) => reserve(s, runKey, ext.leaseMs),
    release: (_s, runKey, owner) => release(runKey, owner),
    execute: (id, input, scope) => ext.execute(id, input, scope),
    record: (s, run, surfaces, lease) => record(s, run, surfaces, lease, ext),
  };
}

export const registeredVerificationDeps = createRegisteredVerificationDeps();

/** The head the coordinator would verify for this task now: its PR head, or its mission's integrated target. */
export async function registeredVerificationHead(taskId: string): Promise<string | null> {
  const s = await loadSubject(taskId, defaults);
  return 'error' in s ? null : s.headSha;
}

/**
 * Why a task token's own task may not request verification of `subjectTaskId`,
 * or null when it may. The result is computed by the server from independent
 * evidence either way, but a task never asks for its own grading: not the
 * subject itself, and not anything filed under it (a fix attempt, a child).
 */
export async function verificationRequesterRefusal(requesterTaskId: string, subjectTaskId: string): Promise<string | null> {
  if (requesterTaskId === subjectTaskId) return 'a task never requests grading of its own outcome';
  if (!isUuid(requesterTaskId)) return 'unknown requesting task';
  const [own] = await db.select({ parentTaskId: tasks.parentTaskId }).from(tasks).where(eq(tasks.id, requesterTaskId)).limit(1);
  if (!own) return 'unknown requesting task';
  if (own.parentTaskId === subjectTaskId) return 'a task filed under the subject never requests its grading';
  return null;
}

/**
 * An automatic run of the coordinator with this store: a PR became ready or
 * moved (`headSha` from the event), or an independent capture arrived (`null`:
 * the head the store resolves). Idempotent per exact identity (the coordinator's
 * `trigger: 'event'`), so a redelivered event changes nothing. Never throws: a
 * registered check that cannot run reads as unverified, and blocks nothing.
 */
export async function runRegisteredVerificationOnEvent(
  taskId: string, headSha: string | null, source: string, deps: Deps = registeredVerificationDeps,
): Promise<RegisteredVerification | null> {
  try {
    const head = headSha ?? (await registeredVerificationHeadWith(taskId, deps));
    if (!head) return null;
    const r = await dispatchRegisteredVerification({ taskId, headSha: head, trigger: 'event' }, deps);
    if (r.reason) console.warn(`[registered-verification] ${source} ${taskId}: ${r.reason}`);
    return r;
  } catch (err) {
    console.error(`[registered-verification] ${source} ${taskId} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

async function registeredVerificationHeadWith(taskId: string, deps: Deps): Promise<string | null> {
  const s = await deps.load(taskId);
  return 'error' in s ? null : s.headSha;
}

/** How many of an audit's dependencies one capture arrival re-verifies. */
export const MAX_ARRIVAL_SUBJECTS = 20;

/**
 * The tasks whose registered checks a [surface audit]'s captures can now
 * decide: the pinned tasks it reviews (its dependencies), and its mission's
 * newest platform final verification. Only those, so an audit's captures are
 * never offered to a subject it does not review; the store still applies the
 * full lineage rule to each capture. Empty for anything but a mission's audit.
 */
export async function subjectsForArrivedCaptures(auditTaskId: string): Promise<string[]> {
  if (!isUuid(auditTaskId)) return [];
  const [audit] = await db.select(auditColumns).from(tasks).where(eq(tasks.id, auditTaskId)).limit(1);
  if (!audit?.missionId || audit.roleSlug !== VISUAL_AUDITOR_ROLE_SLUG || !isSurfaceAuditTask(audit.title)) return [];
  const deps = (Array.isArray(audit.dependsOn) ? audit.dependsOn : []).filter((x): x is string => typeof x === 'string' && isUuid(x)).slice(0, MAX_ARRIVAL_SUBJECTS);
  const pinned = deps.length
    ? (await db.select({ id: tasks.id, workspaceId: tasks.workspaceId, context: tasks.context }).from(tasks).where(inArray(tasks.id, deps)))
      .filter((t) => t.workspaceId === audit.workspaceId && typeof asRecord(asRecord(t.context)?.specSource)?.specRevisionId === 'string')
      .map((t) => t.id)
    : [];
  const [final] = await db.select({ id: tasks.id }).from(tasks)
    .where(and(eq(tasks.missionId, audit.missionId), eq(tasks.workspaceId, audit.workspaceId), eq(tasks.creationSource, 'orchestrator'),
      sql`${tasks.context}->'finalVerification'->>'missionId' = ${audit.missionId}`))
    .orderBy(desc(tasks.createdAt)).limit(1);
  return [...pinned, ...(final ? [final.id] : [])];
}

/** An independent capture arrived (its audit run reported): re-verify every subject it can decide. */
export async function rerunRegisteredVerificationForAudit(auditTaskId: string, deps: Deps = registeredVerificationDeps): Promise<void> {
  for (const taskId of await subjectsForArrivedCaptures(auditTaskId)) {
    await runRegisteredVerificationOnEvent(taskId, null, `captures from audit ${auditTaskId}`, deps);
  }
}
