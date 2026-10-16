/**
 * Failure incident recovery, end to end on real Postgres
 * (docs/specs/failure-incident-recovery.md §12(c)).
 *
 * The production sweep (`runFailurePatternSweep` + `productionSweepDeps`), the
 * real collector, ledger, recovery families, lease, audit rows, escalation
 * gate, Home read and click-time action route, against real rows. Faked only
 * at the edges a test cannot reach: GitHub (the missed-webhook replay), the
 * push transport (`notifyTeam`, recorded) and `emit` (the merge chain the
 * webhook would have run; this suite drives the merge hook itself).
 *
 * The scenario is the stale-blocker case of §2.1: task T waits behind PR A,
 * then PR B; B merges. Then the same through a missed webhook healed by
 * `reconcileStalePrWorkers`. Then the edges that must stay explicit and never
 * read as recovered: an open PR, a closed PR, a held dependency, a stalled CI
 * with its own repair, a cycle, missing evidence, a failed repair, a held and
 * an expired lease, an exhausted budget, a stale click, a recurrence, and the
 * task adapter's superseded questions.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, outboxFor, q, seedTask, seedWorkspace } from './harness';

// ── edges ───────────────────────────────────────────────────────────────────

/** Pushes the gate sent, as `notifyTeam` received them. */
const pushes: Array<{ teamId: string; payload: { title: string; message: string; url: string } }> = [];
const realNotify = await import('../../src/lib/notify');
mock.module('../../src/lib/notify', () => ({
  ...realNotify,
  notifyTeam: async (teamId: string, _kind: string, payload: { title: string; message: string; url: string }) => { pushes.push({ teamId, payload }); },
}));

/** GitHub as the reconcile sweep reads it: the PRs in `mergedOnGithub` are merged, every other PR is open. */
const mergedOnGithub = new Map<string, string>();
const realGithub = await import('../../src/lib/github');
mock.module('../../src/lib/github', () => ({
  ...realGithub,
  githubApi: async (_installationId: number, path: string) => {
    const m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(path);
    if (!m) throw new Error(`fake github: no route for ${path}`);
    const mergedAt = mergedOnGithub.get(`${m[1]}#${m[2]}`);
    return mergedAt
      ? { state: 'closed', merged: true, merged_at: mergedAt, mergeable_state: null }
      : { state: 'open', merged: false, merged_at: null, mergeable_state: 'clean' };
  },
}));
const realInstallation = await import('../../src/lib/workspace-installation');
mock.module('../../src/lib/workspace-installation', () => ({ ...realInstallation, installationIdForRepo: async () => 1 }));
const emitted: Array<{ type: string; prNumber?: number }> = [];
mock.module('../../src/lib/core-emit', () => ({ emit: async (e: { type: string; prNumber?: number }) => { emitted.push(e); } }));

const { db } = await import('@buildd/core/db');
const { recordOrCoalesceDeferral, GATE_SLUGS } = await import('@buildd/core/gate-events');
const { runFailurePatternSweep, productionSweepDeps, reassessIncidentsNamingPr, regateAlert } = await import('../../src/lib/failure-pattern-sweep');
const { productionRecoveryEffects, assessIncident, claimRecoveryLease, readRecovery, RECOVERY_BUDGET_LIMIT } = await import('../../src/lib/failure-incident-recovery');
const { pathOverlapRecoveryFamily } = await import('../../src/lib/failure-incident-recovery-path-overlap');
const { dbRecoveryEvents } = await import('../../src/lib/failure-incident-recovery-events');
const { createDbIncidentPort, recordIncidentCandidates } = await import('../../src/lib/failure-incident-store');
const { actOnIncidentResults, defaultIncidentSender, formatIncidentAlert } = await import('../../src/lib/failure-incident-actions');
const { loadIncidentNeedsYou, loadIncidentVerdicts } = await import('../../src/lib/failure-incident-escalation');
const { projectIncident } = await import('../../src/lib/incident-view');
const { failurePatternSubscribers } = await import('../../src/lib/failure-pattern-subscribers');
const { reconcileStalePrWorkers } = await import('../../src/lib/pr-reconcile');
const { applyIncidentCapability } = await import('../../src/app/api/health/incidents/[id]/actions/apply');
const { productionIncidentActionDeps } = await import('../../src/app/api/health/incidents/[id]/actions/deps');
const { loadSupersededQuestionTaskIds, loadTaskRecoveryViews } = await import('../../src/lib/incident-recovery-load');

type Effects = import('../../src/lib/failure-incident-recovery').RecoveryEffects;
type SweepDeps = import('../../src/lib/failure-pattern-sweep').SweepDeps;
type StoredIncident = import('../../src/lib/failure-incident-store').StoredIncident;

beforeAll(() => { assertDbConfigured(); });

// ── fixtures ────────────────────────────────────────────────────────────────

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const REPO = `acme/recovery-${RUN}`;
let prSeq = 7000 + Math.floor(Math.random() * 1000);
const nextPr = () => ++prSeq;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const ahead = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

/** Words a non-recovered incident must never use (AC-11). */
const RECOVERED_WORDS = /Nothing is fixing|\bfixed\b|\bresolved\b/i;

async function prWorker(workspaceId: string, taskId: string, prNumber: number, opts: { createdMinutesAgo: number; movedMinutesAgo?: number; status?: string; mergedAt?: string | null; lifecycle?: string | null }) {
  await q(sql`INSERT INTO workers (task_id, workspace_id, name, runner, branch, status, pr_url, pr_number, merged_at, pr_lifecycle_status, created_at, updated_at)
    VALUES (${taskId}::uuid, ${workspaceId}::uuid, 'w', 'test', ${`b-${prNumber}`}, ${opts.status ?? 'completed'},
      ${`https://github.com/${REPO}/pull/${prNumber}`}, ${prNumber}, ${opts.mergedAt ?? null}::timestamptz, ${opts.lifecycle ?? null},
      ${ago(opts.createdMinutesAgo)}::timestamptz, ${ago(opts.movedMinutesAgo ?? opts.createdMinutesAgo)}::timestamptz)`);
}

/** The subject's own run starting: a worker row and the task leaving `pending`. */
async function subjectStarts(taskId: string, workspaceId: string) {
  await q(sql`INSERT INTO workers (task_id, workspace_id, name, runner, branch, status) VALUES (${taskId}::uuid, ${workspaceId}::uuid, 'w', 'test', 'b', 'running')`);
  await q(sql`UPDATE tasks SET status = 'in_progress' WHERE id = ${taskId}::uuid`);
}

async function lease(workspaceId: string, taskId: string, path: string) {
  await q(sql`INSERT INTO path_claims (workspace_id, task_id, path) VALUES (${workspaceId}::uuid, ${taskId}::uuid, ${path})`);
}
async function waiter(workspaceId: string, blockingTaskId: string, waitingTaskId: string, path: string) {
  await q(sql`INSERT INTO path_claim_waiters (workspace_id, blocking_task_id, waiting_task_id, blocked_path)
    VALUES (${workspaceId}::uuid, ${blockingTaskId}::uuid, ${waitingTaskId}::uuid, ${path})`);
}

/**
 * One claim-route deferral of `taskId` behind a PR, written through the real
 * coalescing writer, then dated: its streak began `firstMinutesAgo` and its
 * newest poll was `lastMinutesAgo`. Returns the row id.
 */
async function deferBehind(workspaceId: string, taskId: string, blocker: { prNumber: number; taskId: string }, firstMinutesAgo: number, lastMinutesAgo: number, paths: string[] = ['src/shared/x.ts']): Promise<string> {
  const id = await recordOrCoalesceDeferral({
    gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL, surface: 'POST /api/workers/claim', outcome: 'deferred', reason: 'path_overlap',
    workspaceId, taskId, detail: { prNumber: blocker.prNumber, blockingTaskId: blocker.taskId, paths },
  });
  expect(id).toBeTruthy();
  await q(sql`UPDATE gate_events SET occurred_at = ${ago(lastMinutesAgo)}::timestamptz,
    detail = jsonb_set(detail, '{firstDeferredAt}', to_jsonb(${ago(firstMinutesAgo)}::text)) WHERE id = ${id}::uuid`);
  return id!;
}

/** Path-claim wakes written for a task (any delivery state). */
async function releaseWakes(taskId: string) {
  return (await outboxFor(taskId)).filter(r => r.cause === 'path_claim.released' || r.causes.includes('path_claim.released'));
}

async function heldLeases(taskId: string): Promise<number> {
  const [r] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM path_claims WHERE task_id = ${taskId}::uuid AND released_at IS NULL`);
  return Number(r.n);
}

async function incidentsIn(workspaceId: string): Promise<StoredIncident[]> {
  const port = await createDbIncidentPort();
  const rows = await q<{ id: string }>(sql`SELECT id FROM failure_incidents WHERE workspace_id = ${workspaceId}::uuid ORDER BY created_at`);
  return (await Promise.all(rows.map(r => port.findById(r.id)))).filter((x): x is StoredIncident => !!x);
}

async function attemptRows(incidentId: string) {
  return q<{ outcome: string; detail: { actionKey: string; capability: string; verify: { passed: boolean | null } } }>(sql`
    SELECT outcome, detail FROM gate_events WHERE gate = 'incident_recovery' AND detail->>'incidentId' = ${incidentId} ORDER BY occurred_at`);
}

async function taskStatus(taskId: string): Promise<string> {
  const [r] = await q<{ status: string }>(sql`SELECT status FROM tasks WHERE id = ${taskId}::uuid`);
  return r.status;
}

async function expireLease(incidentId: string) {
  await q(sql`UPDATE system_cache SET expires_at = now() - interval '1 second' WHERE key = ${`failure-incident-recovery:${incidentId}`}`);
}

/** Home's Needs You read for these workspaces: the rows the nav badge counts. */
async function homeIncidentIds(workspaceId: string): Promise<string[]> {
  return (await loadIncidentNeedsYou([workspaceId])).map(i => (i as { incidentId?: string }).incidentId!).filter(Boolean);
}

/** The production sweep deps, with no model triage and no fix-task filing (the action layer's own suites cover those). */
function sweepDeps(effects?: Effects, ops: string[] = []): SweepDeps {
  const base = productionSweepDeps();
  return {
    ...base,
    decide: null,
    fixTasks: null,
    recovery: { ...base.recovery!, effects: effects ?? base.recovery!.effects },
    recordLastRun: undefined,
    pruneRecoveryEvents: undefined,
    async reportOpsError(message) { ops.push(message); },
    async recordSelfHealth() { return { consecutiveFailures: 0 }; },
  };
}

const sweep = (workspaceId: string, deps: SweepDeps = sweepDeps(), now?: string) =>
  runFailurePatternSweep(deps, { workspaceIds: [workspaceId], ...(now ? { now: () => now } : {}) });

/** Effects that count each writer call and otherwise run the production writers. */
function countingEffects(over: Partial<Effects> = {}) {
  const real = productionRecoveryEffects();
  const calls = { release: [] as string[], wake: [] as string[], fix: [] as string[] };
  const effects: Effects = {
    async releaseBlocker(taskId, reason, key) { calls.release.push(key); await (over.releaseBlocker ?? real.releaseBlocker)(taskId, reason, key); },
    async wakeSubject(taskId, key) { calls.wake.push(key); await (over.wakeSubject ?? real.wakeSubject)(taskId, key); },
    async fileFixTask(incident, key) { calls.fix.push(key); return (over.fileFixTask ?? real.fileFixTask)(incident, key); },
  };
  return { effects, calls };
}

/** The merge hook as production runs it: the `pr.closed` subscriber. */
async function mergeHook(workspaceId: string, prNumber: number) {
  const s = failurePatternSubscribers.find(x => x.on === 'pr.closed')!;
  await (s.run as (e: unknown) => Promise<void>)({ type: 'pr.closed', workspaceId, prNumber, merged: true });
}

interface Stall {
  workspaceId: string;
  teamId: string;
  /** The task the scenario follows: deferred behind A, then behind B. */
  t: string;
  /** Two more tasks behind B only, so the stall is `high` and Home reads it. */
  others: string[];
  a: { prNumber: number; taskId: string };
  b: { prNumber: number; taskId: string };
}

/**
 * T waits behind PR A for 3 h, then behind PR B. B was opened 3 h ago and holds
 * the overlapping path; T and two siblings wait on it. B's wait is
 * `bWaitMinutes` long. B's worker last moved `bMovedMinutesAgo` ago.
 */
async function stallBehindB(opts: { bWaitMinutes: number; bMovedMinutesAgo?: number; tManifest?: string[]; tDependsOn?: string[]; paths?: string[] }): Promise<Stall> {
  const { workspaceId, teamId } = await seedWorkspace();
  const path = 'src/shared/x.ts';
  const t = await seedTask(workspaceId, { title: 'T', pathManifest: opts.tManifest ?? [path], dependsOn: opts.tDependsOn });
  const others = [await seedTask(workspaceId, { pathManifest: [path] }), await seedTask(workspaceId, { pathManifest: [path] })];
  const aTask = await seedTask(workspaceId, { status: 'completed', pathManifest: [path] });
  const bTask = await seedTask(workspaceId, { status: 'in_progress', pathManifest: [path] });
  const a = { prNumber: nextPr(), taskId: aTask };
  const b = { prNumber: nextPr(), taskId: bTask };
  await prWorker(workspaceId, aTask, a.prNumber, { createdMinutesAgo: 400 });
  await prWorker(workspaceId, bTask, b.prNumber, { createdMinutesAgo: 180, movedMinutesAgo: opts.bMovedMinutesAgo ?? 1, status: 'running' });
  await lease(workspaceId, bTask, path);
  for (const w of [t, ...others]) await waiter(workspaceId, bTask, w, path);
  // Each task's creation wake is not a release wake; start from none pending.
  await q(sql`UPDATE task_dispatch_outbox SET status = 'delivered', delivered_via = 'test:settled'
    WHERE task_id IN (${t}::uuid, ${others[0]}::uuid, ${others[1]}::uuid) AND status IN ('pending', 'delivering')`);

  const aRow = await deferBehind(workspaceId, t, a, 380, 200, opts.paths);
  const bRow = await deferBehind(workspaceId, t, b, opts.bWaitMinutes, 0, opts.paths);
  // G1: a change of blocker starts a new streak, so B's row is its own episode.
  expect(bRow).not.toBe(aRow);
  for (const o of others) await deferBehind(workspaceId, o, b, opts.bWaitMinutes, 0);
  return { workspaceId, teamId, t, others, a, b };
}

// ── 1. the stale blocker, merged through the hook ───────────────────────────

describe('the #4386 scenario: T behind PR A, then PR B; B merges', () => {
  let s: Stall;
  let incident: StoredIncident;

  test('AC-1: ten minutes behind B opens nothing, and A\'s earlier wait is not charged to B', async () => {
    s = await stallBehindB({ bWaitMinutes: 10 });
    const counters = await sweep(s.workspaceId);
    expect(counters.runFailures).toBe(0);
    expect(counters.candidates).toBe(0);
    expect(await incidentsIn(s.workspaceId)).toHaveLength(0);
  });

  test('past the threshold behind B: one high incident whose age starts at B\'s first deferral, waiting on an open PR', async () => {
    // B's streak has now run 150 minutes; nothing about A's 3 h moves.
    await q(sql`UPDATE gate_events SET detail = jsonb_set(detail, '{firstDeferredAt}', to_jsonb(${ago(150)}::text))
      WHERE gate = ${GATE_SLUGS.CLAIM_LOOP_DEFERRAL} AND detail->>'prNumber' = ${String(s.b.prNumber)}
        AND task_id IN (${s.t}::uuid, ${s.others[0]}::uuid, ${s.others[1]}::uuid)`);
    const pushedBefore = pushes.length;
    const counters = await sweep(s.workspaceId);
    expect(counters.runFailures).toBe(0);

    const all = await incidentsIn(s.workspaceId);
    expect(all).toHaveLength(1);
    incident = all[0];
    expect(incident.signature).toContain(`blocker=pr:${s.b.prNumber}`);
    expect(incident.severity).toBe('high');
    expect(incident.affectedRefs.taskIds.sort()).toEqual([s.t, ...s.others].sort());
    // AC-1 / I-8: the occurrence and the episode never reach back before B's first deferral.
    const bFirst = Date.parse(ago(151));
    expect(Date.parse(incident.firstSeenAt)).toBeGreaterThan(bFirst);
    expect(incident.impact.longestStallMinutes).toBeLessThan(160);
    const r = readRecovery(incident)!;
    expect(Date.parse(r.firstSeenAt)).toBeGreaterThan(bFirst);

    // An open PR that is moving: Buildd waits on it; nobody is asked or paged.
    expect(incident.status).toBe('open');
    expect(r.state).toBe('waiting');
    expect(r.owner).toBe('buildd');
    expect(r.cause.reasonCode).toBe('path_overlap.blocker_open');
    expect(r.nextCheckAt! > new Date().toISOString()).toBe(true);
    expect(pushes.length).toBe(pushedBefore);
    expect(await homeIncidentIds(s.workspaceId)).not.toContain(incident.id);
    const view = projectIncident(incident, (await loadIncidentVerdicts(s.teamId, [incident.id])).get(incident.id));
    expect(view.needsYou).toBe(false);
    expect(view.phase).toBe('waiting');
    expect(view.sentence).toContain(`PR #${s.b.prNumber}`);
    expect(view.sentence).not.toMatch(RECOVERED_WORDS);
  });

  test('AC-4: B merges with its leases still held; two concurrent merge-hook runs release it once and wake each task once', async () => {
    // The merge was recorded but the release never ran (G6's shape).
    await q(sql`UPDATE workers SET merged_at = now(), pr_lifecycle_status = 'merged' WHERE pr_number = ${s.b.prNumber} AND workspace_id = ${s.workspaceId}::uuid`);
    await q(sql`UPDATE tasks SET status = 'completed' WHERE id = ${s.b.taskId}::uuid`);
    expect(await heldLeases(s.b.taskId)).toBe(1);

    await Promise.all([mergeHook(s.workspaceId, s.b.prNumber), mergeHook(s.workspaceId, s.b.prNumber)]);

    expect(await heldLeases(s.b.taskId)).toBe(0);
    const attempts = await attemptRows(incident.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].detail.capability).toBe('release_blocker');
    expect(attempts[0].outcome).toBe('accepted');
    for (const task of [s.t, ...s.others]) expect(await releaseWakes(task)).toHaveLength(1);

    const after = (await createDbIncidentPort().then(p => p.findById(incident.id)))!;
    const r = readRecovery(after)!;
    // Whichever run wrote last: the repair in flight, or (re-read after it) the wait for a runner.
    expect(['recovering', 'waiting']).toContain(r.state);
    expect(r.budget.spent).toBe(1);
    expect(r.budget.spentKeys).toContain(attempts[0].detail.actionKey);
    // AC-2: the merge is the start of recovery, not proof of it.
    expect(after.status).toBe('open');
    const view = projectIncident(after, null);
    expect(view.sentence).not.toMatch(RECOVERED_WORDS);
  });

  test('woken but not started yet: still open, no second wake, no second release', async () => {
    await mergeHook(s.workspaceId, s.b.prNumber);
    const after = (await createDbIncidentPort().then(p => p.findById(incident.id)))!;
    expect(after.status).toBe('open');
    expect(readRecovery(after)!.state).not.toBe('recovered');
    expect(await attemptRows(incident.id)).toHaveLength(1);
    for (const task of [s.t, ...s.others]) expect(await releaseWakes(task)).toHaveLength(1);
  });

  test('AC-2: once every task starts, the merge hook resolves it; Home and the badge drop it; the verdict is Buildd\'s', async () => {
    for (const task of [s.t, ...s.others]) await subjectStarts(task, s.workspaceId);
    const pushedBefore = pushes.length;
    await mergeHook(s.workspaceId, s.b.prNumber);

    const after = (await createDbIncidentPort().then(p => p.findById(incident.id)))!;
    expect(after.status).toBe('resolved');
    expect(after.resolvedAt).not.toBeNull();
    const r = readRecovery(after)!;
    expect(r.state).toBe('recovered');
    // I-1, and the release attempt was verified on the same row.
    const [attempt] = await attemptRows(incident.id);
    expect(attempt.detail.verify.passed).toBe(true);
    expect(await homeIncidentIds(s.workspaceId)).toHaveLength(0);
    expect(pushes.length).toBe(pushedBefore);
    const verdict = (await loadIncidentVerdicts(s.teamId, [incident.id])).get(incident.id);
    expect(verdict?.owner).toBe('buildd');
    const view = projectIncident(after, verdict);
    expect(view.phase).toBe('recovered');
    expect(view.sentence).toMatch(/^Recovered at /);
    // Each task woken exactly once over the whole recovery.
    for (const task of [s.t, ...s.others]) expect(await releaseWakes(task)).toHaveLength(1);
  });

  test('AC-12: a fresh occurrence reopens it per the existing policy: recurrence +1, generation +1, budget 0, no page', async () => {
    const port = await createDbIncidentPort();
    const before = (await port.findById(incident.id))!;
    const g = readRecovery(before)!.generation;
    const at = new Date().toISOString();
    // Evidence is keyed by (kind, id): a recurrence is a task the incident has not seen yet.
    const late = await seedTask(s.workspaceId);
    const results = await recordIncidentCandidates([{
      rule: 'path_overlap_stall', reasonCode: 'path_overlap.no_progress', signature: before.signature, detectorVersion: before.detectorVersion,
      workspaceId: s.workspaceId, severity: 'high', title: before.title,
      occurrences: [{ kind: 'task', id: late, at }], evidence: [{ kind: 'task', id: late, at }],
      affected: { taskIds: [late], workerIds: [], prNumbers: [s.b.prNumber] }, impact: { stalledTasks: 1 },
      firstObservedAt: at, lastObservedAt: at,
    }], { port });
    expect(results[0].outcome).toBe('reopened');
    const reopened = results[0].incident;
    expect(reopened.status).toBe('open');
    expect(reopened.recurrenceCount).toBe(before.recurrenceCount + 1);
    const r = readRecovery(reopened)!;
    expect(r.generation).toBe(g + 1);
    expect(r.budget.spent).toBe(0);
    expect(r.budget.spentKeys).toEqual([]);
    expect(r.state).toBe('observing');
    // The attempts already run stay as history.
    expect(r.attempts.length).toBeGreaterThan(0);

    // A reopen re-gates; it pages only if the new generation needs a decision.
    const pushedBefore = pushes.length;
    await actOnIncidentResults(results, { port, decide: null, fixTasks: null, send: defaultIncidentSender() });
    expect(pushes.length).toBe(pushedBefore);
    expect(await homeIncidentIds(s.workspaceId)).not.toContain(incident.id);
  });
});

// ── 2. the same merge, through a missed webhook ─────────────────────────────

describe('missed merge webhook, healed by reconcileStalePrWorkers', () => {
  test('the reconcile releases and wakes once; the backstop resolves only after the tasks start; Home drops it', async () => {
    const s = await stallBehindB({ bWaitMinutes: 150 });
    await sweep(s.workspaceId);
    const [incident] = await incidentsIn(s.workspaceId);
    expect(readRecovery(incident)!.state).toBe('waiting');
    const { effects, calls } = countingEffects();

    // GitHub says B merged; no webhook ever arrived, so the worker row says open.
    mergedOnGithub.set(`${REPO}#${s.b.prNumber}`, new Date().toISOString());
    await q(sql`UPDATE tasks SET status = 'completed' WHERE id = ${s.b.taskId}::uuid`);
    // The sweep is batch-capped and ordered by last check: put every other row behind ours.
    await q(sql`UPDATE workers SET pr_last_checked_at = now() WHERE pr_number IS NOT NULL AND merged_at IS NULL
      AND NOT (workspace_id = ${s.workspaceId}::uuid AND pr_number = ${s.b.prNumber})`);
    const healed = await reconcileStalePrWorkers();
    expect(healed.stamped).toBeGreaterThanOrEqual(1);
    const [bw] = await q<{ merged_at: string | null }>(sql`SELECT merged_at FROM workers WHERE workspace_id = ${s.workspaceId}::uuid AND pr_number = ${s.b.prNumber}`);
    expect(bw.merged_at).not.toBeNull();
    expect(emitted.some(e => e.type === 'pr.merged' && e.prNumber === s.b.prNumber)).toBe(true);
    // G6: the reconcile released the paths itself; the waiters were told once.
    expect(await heldLeases(s.b.taskId)).toBe(0);
    for (const task of [s.t, ...s.others]) expect(await releaseWakes(task)).toHaveLength(1);

    // The backstop (this PR has no kernel delivery to carry the hook): due once nextCheckAt passes.
    const due = readRecovery(incident)!.nextCheckAt!;
    const t1 = new Date(Date.parse(due) + 60_000).toISOString();
    await sweep(s.workspaceId, sweepDeps(effects), t1);
    let row = (await createDbIncidentPort().then(p => p.findById(incident.id)))!;
    expect(row.status).toBe('open');
    expect(readRecovery(row)!.cause.reasonCode).toBe('path_overlap.blocker_merged_unreleased');
    // Nothing left to repair: no release, no wake from recovery.
    expect(calls.release).toEqual([]);
    expect(calls.wake).toEqual([]);

    for (const task of [s.t, ...s.others]) await subjectStarts(task, s.workspaceId);
    const t2 = new Date(Date.parse(readRecovery(row)!.nextCheckAt!) + 60_000).toISOString();
    await sweep(s.workspaceId, sweepDeps(effects), t2);
    row = (await createDbIncidentPort().then(p => p.findById(incident.id)))!;
    expect(row.status).toBe('resolved');
    expect(readRecovery(row)!.state).toBe('recovered');
    expect(calls.release).toEqual([]);
    expect(calls.wake).toEqual([]);
    for (const task of [s.t, ...s.others]) expect(await releaseWakes(task)).toHaveLength(1);
    expect(await homeIncidentIds(s.workspaceId)).toHaveLength(0);
  }, 30_000);
});

// ── 3. edges that must stay explicit ────────────────────────────────────────

describe('a closed PR with unfinished work', () => {
  test('the leases are released as abandoned and the tasks woken; no task is cancelled, nothing resolves until they start', async () => {
    const s = await stallBehindB({ bWaitMinutes: 150 });
    await sweep(s.workspaceId);
    const [incident] = await incidentsIn(s.workspaceId);
    const { effects, calls } = countingEffects();
    const statusesBefore = await q<{ id: string; status: string }>(sql`SELECT id, status FROM tasks WHERE workspace_id = ${s.workspaceId}::uuid ORDER BY id`);

    // B closed unmerged; its own task was still in progress and holds its paths.
    await q(sql`UPDATE workers SET pr_lifecycle_status = 'closed' WHERE workspace_id = ${s.workspaceId}::uuid AND pr_number = ${s.b.prNumber}`);
    const r1 = await reassessIncidentsNamingPr(s.workspaceId, s.b.prNumber, 'merge_hook', sweepDeps(effects));
    expect(r1[0].repair?.action).toBe('release_blocker');
    expect(r1[0].repair?.params.reason).toBe('abandoned');
    expect(calls.release).toHaveLength(1);
    expect(await heldLeases(s.b.taskId)).toBe(0);
    for (const task of [s.t, ...s.others]) expect(await releaseWakes(task)).toHaveLength(1);

    // The work is preserved: no task changed status, the blocker's included.
    const statusesAfter = await q<{ id: string; status: string }>(sql`SELECT id, status FROM tasks WHERE workspace_id = ${s.workspaceId}::uuid ORDER BY id`);
    expect(statusesAfter).toEqual(statusesBefore);
    const row = (await createDbIncidentPort().then(p => p.findById(incident.id)))!;
    expect(row.status).toBe('open');
    expect(projectIncident(row, null).sentence).not.toMatch(RECOVERED_WORDS);
  });
});

describe('a broad manifest and an additional dependency', () => {
  test('woken after the merge but still held by its dependency: waiting, never resolved, paths bounded, the dependency untouched', async () => {
    const { workspaceId: depWs } = await seedWorkspace();
    void depWs;
    const paths = Array.from({ length: 30 }, (_, i) => `apps/web/src/area-${i}/file.ts`);
    // T's manifest is the whole app; it also depends on unfinished work.
    const s = await stallBehindB({ bWaitMinutes: 150, tManifest: ['apps/web'], paths });
    const dep = await seedTask(s.workspaceId, { status: 'in_progress' });
    await q(sql`UPDATE tasks SET depends_on = ${JSON.stringify([dep])}::jsonb WHERE id = ${s.t}::uuid`);
    await sweep(s.workspaceId);
    const [incident] = await incidentsIn(s.workspaceId);
    expect(readRecovery(incident)!.overlappingPaths.length).toBeLessThanOrEqual(20);

    await q(sql`UPDATE workers SET merged_at = now(), pr_lifecycle_status = 'merged' WHERE workspace_id = ${s.workspaceId}::uuid AND pr_number = ${s.b.prNumber}`);
    await mergeHook(s.workspaceId, s.b.prNumber);
    // The siblings start; T cannot (its dependency is still running).
    for (const o of s.others) await subjectStarts(o, s.workspaceId);
    await mergeHook(s.workspaceId, s.b.prNumber);

    const row = (await createDbIncidentPort().then(p => p.findById(incident.id)))!;
    expect(row.status).toBe('open');
    const r = readRecovery(row)!;
    expect(r.state).not.toBe('recovered');
    expect(r.owner).toBe('buildd');
    expect(await taskStatus(s.t)).toBe('pending');
    expect(await taskStatus(dep)).toBe('in_progress');
    expect(await releaseWakes(s.t)).toHaveLength(1);
    expect(projectIncident(row, null).sentence).not.toMatch(RECOVERED_WORDS);
  });
});

describe('a stalled CI with its own repair already running', () => {
  test('recovery waits on the one existing CI retry; repeated and concurrent sweeps add no incident, task, repair or page', async () => {
    const s = await stallBehindB({ bWaitMinutes: 150, bMovedMinutesAgo: 90 });
    // B's CI is red and a CI retry is already on it, pushing to the same PR.
    const retry = await seedTask(s.workspaceId, { status: 'in_progress' });
    await q(sql`UPDATE tasks SET ci_retry_pr_number = ${s.b.prNumber} WHERE id = ${retry}::uuid`);
    await prWorker(s.workspaceId, retry, s.b.prNumber, { createdMinutesAgo: 5, movedMinutesAgo: 0, status: 'running' });
    const { effects, calls } = countingEffects();
    const tasksBefore = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM tasks WHERE workspace_id = ${s.workspaceId}::uuid`);
    const pushedBefore = pushes.length;

    await Promise.all([sweep(s.workspaceId, sweepDeps(effects)), sweep(s.workspaceId, sweepDeps(effects)), sweep(s.workspaceId, sweepDeps(effects))]);
    await sweep(s.workspaceId, sweepDeps(effects));
    await sweep(s.workspaceId, sweepDeps(effects));

    const all = await incidentsIn(s.workspaceId);
    expect(all).toHaveLength(1);
    const r = readRecovery(all[0])!;
    expect(r.state).toBe('waiting');
    expect(r.owner).toBe('buildd');
    expect(r.blockers).toEqual([expect.objectContaining({ kind: 'pr', id: String(s.b.prNumber) })]);
    const [tasksAfter] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM tasks WHERE workspace_id = ${s.workspaceId}::uuid`);
    expect(tasksAfter.n).toBe(tasksBefore[0].n);
    expect(calls).toEqual({ release: [], wake: [], fix: [] });
    expect(await attemptRows(all[0].id)).toHaveLength(0);
    expect(pushes.length).toBe(pushedBefore);
    expect(await homeIncidentIds(s.workspaceId)).toHaveLength(0);
    expect(await taskStatus(retry)).toBe('in_progress');
  }, 30_000);
});

describe('a cycle: the blocker\'s repair depends on the waiting task', () => {
  let s: Stall;
  let incident: StoredIncident;
  let retry: string;

  test('AC-8: a decision at once; Home, the page and the push say the same sentence, once', async () => {
    s = await stallBehindB({ bWaitMinutes: 150 });
    retry = await seedTask(s.workspaceId, { status: 'pending', dependsOn: [] });
    await q(sql`UPDATE tasks SET ci_retry_pr_number = ${s.b.prNumber}, depends_on = ${JSON.stringify([s.t])}::jsonb WHERE id = ${retry}::uuid`);
    const pushedBefore = pushes.length;
    await sweep(s.workspaceId);
    [incident] = await incidentsIn(s.workspaceId);
    const r = readRecovery(incident)!;
    expect(r.state).toBe('needs_decision');
    expect(r.owner).toBe('person');
    expect(r.cause.reasonCode).toBe('path_overlap.cycle');
    expect(r.decision!.options.map(o => o.capability)).toContain('cancel_attempt');

    // One push, and its words are the projection's.
    expect(pushes.length).toBe(pushedBefore + 1);
    const push = pushes[pushes.length - 1];
    const verdict = (await loadIncidentVerdicts(s.teamId, [incident.id])).get(incident.id)!;
    expect(verdict.owner).toBe('person');
    expect(verdict.generation).toBe(r.generation);
    const view = projectIncident(incident, verdict);
    const home = (await loadIncidentNeedsYou([s.workspaceId])) as Array<{ incidentId?: string; failureMessage?: string }>;
    const card = home.find(i => i.incidentId === incident.id)!;
    expect(card.failureMessage).toBe(view.sentence);
    expect(push.payload.message).toContain(view.sentence);
    expect(push.payload.url).toContain(`/app/incidents/${incident.id}`);
    expect(view.sentence).toBe(r.decision!.question);
    expect(view.sentence).not.toMatch(RECOVERED_WORDS);

    // A replay of the same state does not page again.
    await sweep(s.workspaceId, sweepDeps(), new Date(Date.now() + 10 * 60_000).toISOString());
    expect(pushes.length).toBe(pushedBefore + 1);
  });

  test('AC-7: a click on the old generation answers 409 with the new assessment and cancels nothing', async () => {
    const g1 = readRecovery((await createDbIncidentPort().then(p => p.findById(incident.id)))!)!.generation;
    // The repair attempt no longer depends on T: the cause, and so the generation, changes.
    await q(sql`UPDATE tasks SET depends_on = '[]'::jsonb WHERE id = ${retry}::uuid`);
    const deps = await productionIncidentActionDeps(s.teamId);
    const res = await applyIncidentCapability(deps, incident.id, { capability: 'cancel_attempt', generation: g1 });
    expect(res.status).toBe(409);
    if (res.status !== 409) throw new Error('expected 409');
    expect(res.body.reason).toBe('generation_changed');
    expect(res.body.projection.generation).toBe(g1 + 1);
    expect(res.body.projection.phase).toBe('waiting');
    expect(await taskStatus(retry)).toBe('pending');
    expect(await taskStatus(s.t)).toBe('pending');
  });

  test('AC-5: the stored person verdict is from the older generation, so Home and the badge drop it', async () => {
    const row = (await createDbIncidentPort().then(p => p.findById(incident.id)))!;
    expect(readRecovery(row)!.state).toBe('waiting');
    expect(await homeIncidentIds(s.workspaceId)).not.toContain(incident.id);
    const verdict = (await loadIncidentVerdicts(s.teamId, [incident.id])).get(incident.id);
    expect(projectIncident(row, verdict).needsYou).toBe(false);
  });
});

describe('evidence that cannot be read, effects that fail, leases and budgets', () => {
  test('AC-3: an old assessment whose re-read is incomplete is inconclusive and stays open', async () => {
    const s = await stallBehindB({ bWaitMinutes: 150 });
    await sweep(s.workspaceId);
    const port = await createDbIncidentPort();
    let [incident] = await incidentsIn(s.workspaceId);
    // The last observation is 90 minutes old, and one named task can no longer be read.
    const r0 = readRecovery(incident)!;
    const ghost = '00000000-0000-4000-8000-00000000dead';
    await q(sql`UPDATE failure_incidents SET
      recovery = jsonb_set(recovery, '{observation,observedAt}', to_jsonb(${ago(90)}::text)),
      affected_refs = jsonb_set(affected_refs, '{taskIds}', affected_refs->'taskIds' || ${JSON.stringify([ghost])}::jsonb)
      WHERE id = ${incident.id}::uuid`);
    incident = (await port.findById(incident.id))!;
    expect(projectIncident(incident, null).phase).toBe('inconclusive');

    const res = await assessIncident({ port, families: [pathOverlapRecoveryFamily], effects: productionRecoveryEffects(), claimLease: claimRecoveryLease, events: dbRecoveryEvents() }, incident.id, 'backstop');
    expect(res.outcome).toBe('assessed');
    const row = (await port.findById(incident.id))!;
    expect(row.status).toBe('open');
    const r = readRecovery(row)!;
    expect(r.state).toBe('inconclusive');
    expect(r.owner).toBe('buildd');
    expect(r.nextCheckAt! > new Date().toISOString()).toBe(true);
    // The subject set grew, which is a new generation (§3).
    expect(r.generation).toBe(r0.generation + 1);
    const view = projectIncident(row, null);
    expect(view.stateWord).toBe("Couldn't confirm");
    expect(view.sentence).not.toMatch(RECOVERED_WORDS);
    expect(view.needsYou).toBe(false);

    // A read that throws outright: the same, on the stored cause and subjects, never recovered.
    const failing = { ...pathOverlapRecoveryFamily, observe: async () => { throw new Error('connection reset'); } };
    const again = await assessIncident({ port, families: [failing], effects: productionRecoveryEffects() }, incident.id, 'backstop');
    expect(again.outcome).toBe('assessed');
    const after = (await port.findById(incident.id))!;
    expect(after.status).toBe('open');
    expect(readRecovery(after)!.state).toBe('inconclusive');
    expect(readRecovery(after)!.generation).toBe(r.generation);
    expect(readRecovery(after)!.observation.evidenceRevision).toBe('unreadable');
  });

  test('a failed repair, a held lease, an expired lease and an exhausted budget: each explicit, none resolved (AC-6)', async () => {
    const s = await stallBehindB({ bWaitMinutes: 150 });
    await sweep(s.workspaceId);
    const port = await createDbIncidentPort();
    const [incident] = await incidentsIn(s.workspaceId);
    // B merged, the release never ran, and the release writer now fails.
    await q(sql`UPDATE workers SET merged_at = now(), pr_lifecycle_status = 'merged' WHERE workspace_id = ${s.workspaceId}::uuid AND pr_number = ${s.b.prNumber}`);
    const { effects, calls } = countingEffects({ releaseBlocker: async () => { throw new Error('release writer unavailable'); } });
    let clock = Date.now();
    const deps = () => ({ port, families: [pathOverlapRecoveryFamily], effects, claimLease: claimRecoveryLease, events: dbRecoveryEvents(), now: () => new Date(clock).toISOString() });
    const step = async (minutes: number) => { clock += minutes * 60_000; return assessIncident(deps(), incident.id, 'backstop'); };

    // Attempt 1 runs and fails: recorded as rejected, the key spent, re-checked in 2 minutes.
    let res = await step(0);
    expect(res.outcome).toBe('repaired');
    expect(calls.release).toHaveLength(1);
    let rows = await attemptRows(incident.id);
    expect(rows.map(r => r.outcome)).toEqual(['rejected']);
    let row = (await port.findById(incident.id))!;
    expect(row.status).toBe('open');
    expect(readRecovery(row)!.state).toBe('recovering');
    expect(await heldLeases(s.b.taskId)).toBe(1);

    // Inside the re-check window: the same repair is in flight; nothing runs.
    res = await step(1);
    expect(res.repair).toBeNull();
    expect(calls.release).toHaveLength(1);

    // Re-check due, but the lease from attempt 1 is still held: contended, nothing runs.
    res = await step(2);
    expect(res.outcome).toBe('contended');
    expect(calls.release).toHaveLength(1);

    // The lease expires: the next look takes it over and runs attempt 2, then 3.
    await expireLease(incident.id);
    res = await step(0);
    expect(res.outcome).toBe('repaired');
    await expireLease(incident.id);
    res = await step(3);
    expect(res.outcome).toBe('repaired');
    expect(calls.release).toHaveLength(RECOVERY_BUDGET_LIMIT);
    rows = await attemptRows(incident.id);
    expect(rows).toHaveLength(RECOVERY_BUDGET_LIMIT);
    expect(new Set(rows.map(r => r.detail.actionKey)).size).toBe(RECOVERY_BUDGET_LIMIT);
    expect(rows.every(r => r.outcome === 'rejected')).toBe(true);

    // The budget is spent: a fourth repair is refused and a person is asked one typed question.
    await expireLease(incident.id);
    res = await step(3);
    expect(calls.release).toHaveLength(RECOVERY_BUDGET_LIMIT);
    row = (await port.findById(incident.id))!;
    const r = readRecovery(row)!;
    expect(r.state).toBe('needs_decision');
    expect(r.owner).toBe('person');
    expect(r.budget.spent).toBe(RECOVERY_BUDGET_LIMIT);
    expect(r.decision!.options.length).toBeGreaterThan(0);
    expect(row.status).toBe('open');
    expect(row.resolvedAt).toBeNull();
    expect(await heldLeases(s.b.taskId)).toBe(1);
    // None of the failed attempts was ever marked as having worked.
    rows = await attemptRows(incident.id);
    expect(rows.some(x => x.detail.verify.passed === true)).toBe(false);

    // The gate hands it to the person; Home lists it with the projection's words.
    const pushedBefore = pushes.length;
    await defaultIncidentSender()(regateAlert(row));
    expect(pushes.length).toBe(pushedBefore + 1);
    const verdict = (await loadIncidentVerdicts(s.teamId, [incident.id])).get(incident.id)!;
    const view = projectIncident(row, verdict);
    expect(view.needsYou).toBe(true);
    const card = ((await loadIncidentNeedsYou([s.workspaceId])) as Array<{ incidentId?: string; failureMessage?: string }>).find(i => i.incidentId === incident.id)!;
    expect(card.failureMessage).toBe(view.sentence);
    expect(pushes[pushes.length - 1].payload.message).toContain(view.sentence);
    expect(formatIncidentAlert(row, { severity: row.severity, reason: 'opened' }, { verdict }).message).toContain(view.sentence);
    for (const text of [view.sentence, card.failureMessage!, pushes[pushes.length - 1].payload.message]) expect(text).not.toMatch(RECOVERED_WORDS);

    // Dismissing it through the action route: off Home, not resolved, Buildd keeps checking.
    const actionDeps = await productionIncidentActionDeps(s.teamId);
    const dismissed = await applyIncidentCapability(actionDeps, incident.id, { capability: 'dismiss', generation: r.generation });
    expect(dismissed.status).toBe(200);
    row = (await port.findById(incident.id))!;
    expect(row.status).toBe('acknowledged');
    expect(await homeIncidentIds(s.workspaceId)).not.toContain(incident.id);

    // AC-10: dismissal is not resolution; Buildd keeps checking, and a passing check still resolves it.
    const { releaseAndNotify } = await import('../../src/lib/path-claim-release');
    await releaseAndNotify(s.b.taskId, 'merged');
    for (const task of [s.t, ...s.others]) await subjectStarts(task, s.workspaceId);
    await expireLease(incident.id);
    await assessIncident({ ...deps(), effects: productionRecoveryEffects() }, incident.id, 'backstop');
    row = (await port.findById(incident.id))!;
    expect(row.status).toBe('resolved');
    expect(readRecovery(row)!.state).toBe('recovered');
  }, 30_000);
});

// ── 4. the task adapter: questions recovery has superseded ──────────────────

describe('task questions and the recovery that owns them', () => {
  async function waitingQuestion(workspaceId: string, taskId: string) {
    const waitingFor = { type: 'question', prompt: 'How should I proceed?', options: ['Sync dev', 'Capture dev', 'Cancel'] };
    await q(sql`INSERT INTO workers (task_id, workspace_id, name, runner, branch, status, waiting_for)
      VALUES (${taskId}::uuid, ${workspaceId}::uuid, 'w', 'test', 'b', 'waiting_input', ${JSON.stringify(waitingFor)}::jsonb)`);
    return waitingFor;
  }
  async function refTo(taskId: string, incidentId: string, generation: number) {
    await q(sql`UPDATE tasks SET context = coalesce(context, '{}'::jsonb) || jsonb_build_object('incidentRecovery', jsonb_build_object('incidentId', ${incidentId}::text, 'generation', ${generation}::int))
      WHERE id = ${taskId}::uuid`);
  }

  test('legacy, Buildd-owned, decision and unreadable: only a Buildd-owned recovery supersedes, and the question is kept as history', async () => {
    const s = await stallBehindB({ bWaitMinutes: 150 });
    await sweep(s.workspaceId);
    const [waiting] = await incidentsIn(s.workspaceId);
    expect(readRecovery(waiting)!.state).toBe('waiting');

    const legacy = await seedTask(s.workspaceId);
    const owned = await seedTask(s.workspaceId);
    const decided = await seedTask(s.workspaceId);
    const unreadable = await seedTask(s.workspaceId);
    for (const t of [legacy, owned, decided, unreadable]) await waitingQuestion(s.workspaceId, t);

    // A decision incident: the cycle shape, on a second blocker in the same workspace.
    const cyc = await stallBehindB({ bWaitMinutes: 150 });
    const retry = await seedTask(cyc.workspaceId, { status: 'pending' });
    await q(sql`UPDATE tasks SET ci_retry_pr_number = ${cyc.b.prNumber}, depends_on = ${JSON.stringify([cyc.t])}::jsonb WHERE id = ${retry}::uuid`);
    await sweep(cyc.workspaceId);
    const [decision] = await incidentsIn(cyc.workspaceId);
    expect(readRecovery(decision)!.state).toBe('needs_decision');

    await refTo(owned, waiting.id, readRecovery(waiting)!.generation);
    await refTo(decided, decision.id, readRecovery(decision)!.generation);
    await refTo(unreadable, '00000000-0000-4000-8000-00000000beef', 1);

    const superseded = await loadSupersededQuestionTaskIds([legacy, owned, decided, unreadable]);
    // A legacy question with no recovery on record is left exactly as it is.
    expect(superseded.has(legacy)).toBe(false);
    // Buildd owns the next step: the stale question is out of every Needs You read.
    expect(superseded.has(owned)).toBe(true);
    // A genuine decision keeps the person's controls.
    expect(superseded.has(decided)).toBe(false);
    // An incident that cannot be read is unknown, not superseded.
    expect(superseded.has(unreadable)).toBe(false);

    const views = await loadTaskRecoveryViews([owned, decided]);
    expect(views.get(owned)).toMatchObject({ ownerLabel: 'Buildd', phase: 'waiting', holdsCompletion: true });
    expect(views.get(decided)).toMatchObject({ ownerLabel: 'You', phase: 'decision', supersedesQuestion: false });
    expect(views.get(owned)!.sentence).not.toMatch(/How should I proceed/);

    // Superseding is a read: the worker, its question and its status are all still there.
    const kept = await q<{ status: string; waiting_for: { prompt: string } }>(sql`
      SELECT status, waiting_for FROM workers WHERE task_id IN (${legacy}::uuid, ${owned}::uuid) ORDER BY created_at`);
    expect(kept).toHaveLength(2);
    expect(kept.every(k => k.status === 'waiting_input' && k.waiting_for.prompt === 'How should I proceed?')).toBe(true);
  }, 30_000);
});

// Shared DB: nothing here truncates. Every query above is scoped to a workspace this file seeded.
void db;
