/**
 * Spec 072de598 I-14 / AC-13: a visual audit that never ran because build work
 * it depends on failed. One scenario per case, each read through the whole
 * derived chain a surface renders from: the review model's phase, the mission
 * visual-review state, its presentation, the Verify row, the scheduler's plan,
 * the task's failure kind, its action set and its verdict. Copy is asserted
 * only where the contract names it; the rest is state.
 */
import { describe, expect, it } from 'bun:test';
import { VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';
import { dependencyFailedResult, dependencyFailureOf } from '@buildd/core/dependency-failure';
import { buildVisualReviewModel, type BuildVisualReviewInput, type VisualReviewShotRow, type VisualReviewTaskInput } from './visual-review-model';
import { deriveMissionVisualReview, type VisualReviewStateInput } from './workflow/visual-review-state';
import { presentVisualReview } from './workflow/visual-review-presentation';
import { resolveVisualReviewPolicy } from './workflow/visual-review-policy';
import { planVisualReviewSchedule, type ScheduleAudit } from './workflow/visual-review-schedule';
import { visualCheck } from './mission-checks';
import { classifyTaskFailure, failedDependencyOf } from './task-failure-kind';
import { taskActionSet } from './task-actions';
import { deriveTaskVerdict } from './task-verdict';

const T0 = Date.parse('2026-10-17T12:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const NOW = T0 + 24 * 60 * 60_000;
const HEAD = 'abc1234def';

const BUILD = { id: 'build-1', title: 'Make PR review decisions commit-scoped and truthful' };
const AUDIT_TITLE = '[surface audit] Kernel mission';

const build = (status: string, workers: VisualReviewTaskInput['workers'] = []): VisualReviewTaskInput => ({
  ...BUILD, status, createdAt: at(0), updatedAt: at(10), workers,
});
const audit = (status: string, over: Partial<VisualReviewTaskInput> = {}): VisualReviewTaskInput => ({
  id: 'audit-1', title: AUDIT_TITLE, status, roleSlug: VISUAL_AUDITOR_ROLE_SLUG,
  createdAt: at(1), updatedAt: at(11), dependsOn: [BUILD.id], context: {}, workers: [], ...over,
});
/** What the cascade writes on the audit, and the older rows' text-only form. */
const cascaded = dependencyFailedResult(BUILD);
const legacy = { error: `Blocked: dependency "${BUILD.title}" (11111111-2222-3333-4444-555555555555) failed` };

const shot = (id: string, viewport: 'mobile' | 'desktop', verdict: 'ok' | 'issue'): VisualReviewShotRow => ({
  id, type: 'screenshot', createdAt: at(30), workerId: 'aw1', taskId: 'audit-1',
  metadata: { qa: { runKey: 'r1', route: '/app/missions/:id', viewport, verdict, finding: verdict === 'ok' ? 'Fits.' : 'Title overflows.' } },
});

function model(tasks: VisualReviewTaskInput[], shots: VisualReviewShotRow[] = []) {
  const input: BuildVisualReviewInput = { missionId: 'm1', shots, tasks, now: NOW };
  return buildVisualReviewModel(input);
}

/** The mission's visual-review state from a model, the way the loader builds it. */
function stateOf(m: ReturnType<typeof model>, over: Partial<VisualReviewStateInput> = {}) {
  return deriveMissionVisualReview({
    policy: resolveVisualReviewPolicy({}),
    uiChange: { state: 'yes', source: 'diff', uiFiles: 2 },
    audit: m.audit ? { id: m.audit.id, createdAt: m.audit.createdAt, errorType: m.audit.errorType, status: m.audit.status } : null,
    review: m.audit
      ? {
          phase: m.phase, screens: m.summary.shots, effectiveIssues: m.summary.effectiveIssues, awaitingHuman: m.summary.awaitingHuman,
          openFixes: 0, roundCapOpen: m.roundCapOpen, needsYouReason: m.needsYou?.reason ?? null,
          captured: m.progress?.captured ?? 0, expected: m.progress?.expected ?? null, waitingOn: m.waitingOn ?? null,
        }
      : null,
    waiver: null,
    auditedSha: HEAD,
    branch: { headSha: HEAD, base: 'dev', integrationPr: null, workLanded: true },
    ...over,
  });
}

const row = (s: ReturnType<typeof stateOf>) => visualCheck(s, { mergeTier: 'agent-review' });
const sched = (a: ScheduleAudit[], s: ReturnType<typeof stateOf>) => planVisualReviewSchedule({
  state: s, impact: { verdict: 'review_required', headSha: HEAD }, audits: a, browserRunnerOnline: true, executorLocal: false, now: NOW,
});
const ledger = (status: string, result: unknown, over: Partial<ScheduleAudit> = {}): ScheduleAudit => ({
  id: 'audit-1', status, round: 1, headSha: HEAD, updatedAt: NOW - 60_000, dependencyFailed: status === 'failed' ? dependencyFailureOf(result) : null, ...over,
});
const failureTask = (t: VisualReviewTaskInput) => ({ id: t.id, title: t.title ?? '', status: t.status, result: t.result, workers: (t.workers ?? []).map(w => ({ status: w.status ?? '' })) });

describe('scenario: prerequisite failed before the audit was dispatched', () => {
  const tasks = [build('failed'), audit('failed', { result: cascaded })];
  const m = model(tasks);
  const s = stateOf(m);

  it('the model reads waiting on the failed task, never failed', () => {
    expect(m.phase).toBe('waiting_on_failed_work');
    expect(m.waitingOn).toEqual({ taskId: BUILD.id, title: BUILD.title });
  });

  it('the state is queued with no actor and no system failure, and still holds completion', () => {
    expect(s).toMatchObject({ status: 'queued', nextActor: 'none', waitingOn: { taskId: BUILD.id }, blocksCompletion: true, pendingVerification: true });
    expect(s.blocked).toBeUndefined();
  });

  it('the Verify row is queued, names the failed task, offers no report and links the root failure', () => {
    const r = row(s);
    expect(r).toMatchObject({ status: 'queued', state: 'waiting on failed work', actor: 'none', problem: null });
    expect(r.detail).toContain(BUILD.title);
    expect(r.evidence).toContainEqual({ label: 'Open the failed task', href: `/app/tasks/${BUILD.id}` });
    const p = presentVisualReview(s);
    expect(p.report).toBeNull();
    expect(p.needsYou).toBe(false);
    expect(p.owner).toBeNull();
  });

  it('the scheduler neither retries it nor counts it as an attempt', () => {
    expect(sched([ledger('failed', cascaded)], s)).toEqual({ action: 'none', why: 'waiting_on_failed_work' });
  });

  it('the audit task offers no Retry on a backend or Retry the audit, only the failed task', () => {
    const kind = classifyTaskFailure(failureTask(tasks[1]), tasks.map(failureTask));
    expect(kind).toBe('dependency');
    const actions = taskActionSet({ phase: 'failed', isBlocked: false, backend: 'claude', hasQuestion: false, hasHistory: true, failureKind: kind, otherBackendAvailable: true });
    expect(actions).toEqual(['waiting_on_failed', 'history']);
    expect(actions).not.toContain('retry');
    expect(actions).not.toContain('switch_backend');
    expect(actions).not.toContain('verification_failed');
    const waitingOn = failedDependencyOf(failureTask(tasks[1]), tasks.map(failureTask));
    const v = deriveTaskVerdict({ taskStatus: 'failed', live: null, openQuestion: false, pr: null, checks: null, openAttempt: null, waitingOnFailed: { ...waitingOn!, requeuesItself: true } });
    expect(v).toMatchObject({ state: 'blocked', headline: 'Waiting on failed work', causeKey: 'blocked:dependency_failed' });
    expect(v!.actions.map(a => a.href)).toEqual([`/app/tasks/${BUILD.id}`]);
  });

  it('rows written before errorType are read the same way', () => {
    const old = model([build('failed'), audit('failed', { result: legacy })]);
    expect(old.phase).toBe('waiting_on_failed_work');
    expect(old.waitingOn?.title).toBe(BUILD.title);
  });

  it('the projected result digest is enough (the review query never loads the whole result)', () => {
    const projected = model([build('failed'), audit('failed', { dependencyFailure: { errorType: 'dependency_failed', blockedBy: cascaded.blockedBy, error: cascaded.error } })]);
    expect(projected.phase).toBe('waiting_on_failed_work');
  });
});

describe('scenario: prerequisite failed after the audit was queued', () => {
  // Queued first: the build was still running, so the audit waited on it.
  it('queued audit waits on its dependency, and the system acts next', () => {
    const before = stateOf(model([build('in_progress'), audit('pending')]));
    expect(before).toMatchObject({ status: 'queued', nextActor: 'system' });
    expect(before.waitingOn).toBeUndefined();
  });

  it('after the cascade it reads waiting on failed work, with nothing to retry', () => {
    const tasks = [build('failed'), audit('failed', { result: cascaded })];
    const after = stateOf(model(tasks));
    expect(after).toMatchObject({ status: 'queued', nextActor: 'none', waitingOn: { taskId: BUILD.id } });
    expect(row(after).status).toBe('queued');
  });

  it('once the prerequisite completes and the audit is re-queued, it is an ordinary queued audit again', () => {
    const s = stateOf(model([build('completed'), audit('pending')]));
    expect(s).toMatchObject({ status: 'queued', nextActor: 'system' });
    expect(s.waitingOn).toBeUndefined();
  });

  it('a builder failed the same way waits too, until its dependency recovers; then Retry is offered again', () => {
    const builder = { id: 'b2', title: 'Second builder', status: 'failed', result: cascaded, workers: [] };
    expect(classifyTaskFailure(builder, [builder, { ...BUILD, status: 'failed', workers: [] }])).toBe('dependency');
    expect(classifyTaskFailure(builder, [builder, { ...BUILD, status: 'completed', workers: [] }])).toBe('execution');
  });
});

describe('scenario: a legitimate completed audit later goes stale', () => {
  const tasks = [build('completed'), audit('completed', { workers: [{ id: 'aw1', status: 'completed', startedAt: at(20) }] })];
  const shots = [shot('s1', 'mobile', 'ok'), shot('s2', 'desktop', 'ok')];

  it('passed on the head it looked at', () => {
    expect(row(stateOf(model(tasks, shots))).status).toBe('passed');
  });

  it('stale on a new head, never waiting on failed work', () => {
    const s = stateOf(model(tasks, shots), { branch: { headSha: 'fff9999', base: 'dev', integrationPr: null, workLanded: true } });
    expect(s.staleEvidence).toBe(true);
    expect(s.waitingOn).toBeUndefined();
    expect(row(s).status).toBe('stale');
  });
});

describe('scenario: the audit worker failed on infrastructure', () => {
  const tasks = [build('completed'), audit('failed', { errorType: 'infra_stalled', result: { errorType: 'infra_stalled' }, workers: [{ id: 'aw1', status: 'failed', startedAt: at(20) }] })];
  const s = stateOf(model(tasks));

  it('is a system failure the system retries, not a wait on other work', () => {
    expect(model(tasks).phase).toBe('stalled');
    expect(s).toMatchObject({ status: 'blocked', nextActor: 'system', blocked: { cause: 'stalled', causeOwner: 'buildd' } });
    expect(s.waitingOn).toBeUndefined();
    expect(row(s)).toMatchObject({ status: 'unable' });
  });

  it('the scheduler backs off then retries it, counting the attempt', () => {
    const plan = sched([ledger('failed', { errorType: 'infra_stalled' }, { updatedAt: NOW - 1000 })], s);
    expect(plan.action).toBe('wait');
    const later = sched([ledger('failed', { errorType: 'infra_stalled' }, { updatedAt: NOW - 24 * 60 * 60_000 })], s);
    expect(later).toMatchObject({ action: 'enqueue', reason: 'retry', attempt: 2 });
  });

  it('its own task keeps the execution recovery (a worker really died)', () => {
    expect(classifyTaskFailure(failureTask(tasks[1]), tasks.map(failureTask))).toBe('execution');
  });

  it('a dependency-failed audit on the same head does not use up the retry budget', () => {
    // Newest first: a real infra failure, and before it one the cascade failed.
    const plan = sched([
      ledger('failed', { errorType: 'infra_stalled' }, { id: 'a3', updatedAt: NOW - 24 * 60 * 60_000 }),
      ledger('failed', cascaded, { id: 'a2', updatedAt: NOW - 25 * 60 * 60_000 }),
    ], s);
    expect(plan).toMatchObject({ action: 'enqueue', attempt: 2 });
  });
});

describe('scenario: an actual visual finding', () => {
  const tasks = [build('completed', [{ id: 'bw', status: 'completed', startedAt: at(2), prUrl: 'https://example.test/pull/1', prNumber: 1, mergedAt: at(9) }]),
    audit('completed', { workers: [{ id: 'aw1', status: 'completed', startedAt: at(20) }] })];
  const shots = [shot('s1', 'mobile', 'issue'), shot('s2', 'desktop', 'ok')];

  it('is a product finding, never a wait or a system failure', () => {
    const s = stateOf(model(tasks, shots));
    expect(s.status).toBe('findings');
    expect(s.waitingOn).toBeUndefined();
    const r = row(s);
    expect(r.problem).toBe('product');
    expect(r.status === 'finding' || r.status === 'owner').toBe(true);
  });

  it('a landed builder beside a dependency-failed audit is not "verification failed"', () => {
    const landed = { id: 'b1', title: 'Landed', status: 'failed', workers: [{ status: 'completed', prUrl: 'https://example.test/pull/1', mergedAt: at(9) }] };
    const blockedAudit = { id: 'audit-1', title: AUDIT_TITLE, status: 'failed', result: cascaded, workers: [] };
    expect(classifyTaskFailure(landed, [landed, blockedAudit])).toBe('execution');
    const ranAudit = { ...blockedAudit, result: { errorType: 'max_turns' }, workers: [{ status: 'completed' }] };
    expect(classifyTaskFailure(landed, [landed, ranAudit])).toBe('verification');
  });
});

describe('scenario: Skip under strict and non-strict policy', () => {
  const m = model([build('failed'), audit('failed', { result: cascaded })]);

  it('non-strict: Skip is offered on the waiting row (I-7), with no retry beside it', () => {
    const r = row(stateOf(m));
    expect(r.waivable).toBe(true);
    expect(presentVisualReview(stateOf(m)).report).toBeNull();
  });

  it('strict: no Skip, and still nothing to retry', () => {
    const strict = stateOf(m, { policy: resolveVisualReviewPolicy({ workspace: 'strict' }) });
    expect(strict.status).toBe('queued');
    const r = row(strict);
    expect(r.waivable).toBe(false);
    expect(r.status).toBe('queued');
  });

  it('a waiver recorded after the audit stands', () => {
    const waived = stateOf(m, { waiver: { reason: 'Copy only', actorLabel: 'Owner', at: at(60) } });
    expect(row(waived).status).toBe('waived');
  });
});
