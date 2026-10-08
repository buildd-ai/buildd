/**
 * Quality Scout run, finding and follow-up ledger SQL, against real Postgres.
 *
 * The unit suites drive in-memory fakes, and a mocked `db` makes every WHERE
 * clause unobservable. These pin the scoping that decides correctness: one
 * winner per run id (insert or takeover), only a failed or stale run is taken
 * over, a finding is keyed by (workspace, signature) and no write reaches
 * another workspace's row, a dismissal survives later runs, a retire touches
 * only its own task, and the periodic sweep reads each workspace's own last
 * run. The follow-up claim/hold path is in quality-scout-follow-up.test.ts.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { qualityScoutFindings, qualityScoutProbes, qualityScoutRuns, tasks } from '@buildd/core/db/schema';
import {
  dbScoutFindingStore,
  dismissScoutFindingRow,
  executeScoutProbe,
  recordScoutFailure,
  resolveScoutFindingsForPass,
  saveScoutProbes,
  saveScoutRun,
  scoutDismissal,
  scoutProbeRecord,
  type ScoutCandidateLike,
} from '@buildd/core/quality-scout/ledger';
import type { ScoutProbeRecord, ScoutRun } from '@buildd/core/quality-scout/types';
import type { VerificationExecutor } from '@buildd/core/verification-check';
import { dbScoutActionStore } from '@/lib/quality-scout-actions';
import { scoutRunId } from '@/lib/quality-scout-run';
import { dbPeriodicScoutDeps, dbScoutRunLedger, runPeriodicQualityScouts, type PeriodicScoutDeps } from '@/lib/quality-scout-trigger';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const HOUR = 3_600_000;
let n = 0;

beforeAll(() => {
  assertDbConfigured();
});

function scoutRun(workspaceId: string, over: Partial<ScoutRun> = {}): ScoutRun {
  return {
    id: crypto.randomUUID(),
    workspaceId,
    missionId: null,
    trigger: 'manual',
    mode: 'shadow',
    status: 'running',
    candidate: { ref: 'main', sha: SHA },
    prior: null,
    budget: { maxProbes: 4, maxCostUsd: null },
    policyVersion: 'scout-v1',
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    ...over,
  };
}

const runRow = async (id: string) => (await db.select().from(qualityScoutRuns).where(eq(qualityScoutRuns.id, id)))[0];
const probeCount = async (runId: string) =>
  (await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM quality_scout_probes WHERE run_id = ${runId}::uuid`))[0].n;

function candidate(): ScoutCandidateLike {
  return {
    id: `cand-${Date.now().toString(36)}-${n++}`,
    family: 'contract',
    probeKind: 'cli-journey',
    title: 'CLI exits non-zero on bad input',
    invariant: 'The CLI exits non-zero when given an unknown flag.',
    sourceSignals: [{ type: 'change', ref: 'src/cli.ts' }],
    preconditions: ['cli-journey'],
    executor: 'cli-journey:bad-flag',
    estimatedCost: 'low',
    severity: 'high',
    evidenceRequirements: ['command-output'],
  };
}
const SELECTED = { status: 'selected', via: 'decision', reasonCode: 'changed_surface', decisionSource: 'model' } as const;

const exec: VerificationExecutor<{ exit: number }> = {
  kind: 'command',
  requires: [],
  run: (i) => (i.exit === 0
    ? { verdict: 'fail', observed: 'exit 0 on --nope', evidenceRefs: [{ kind: 'command_output', ref: 'ev-1' }], confidence: 0.9 }
    : { verdict: 'pass', observed: `exit ${i.exit}` }),
};

/** The same candidate yields the same check id and signature in every workspace. */
function executed(r: ScoutRun, c: ScoutCandidateLike, verdict: 'fail' | 'pass'): ScoutProbeRecord {
  return executeScoutProbe(r, scoutProbeRecord(c, SELECTED), exec, {
    input: { exit: verdict === 'fail' ? 0 : 2 },
    evidence: { 'command-output': 'complete' },
    capabilities: ['cli-journey:bad-flag'],
    now: new Date(),
  });
}

const finding = async (workspaceId: string, signature: string) =>
  (await db.select().from(qualityScoutFindings)
    .where(and(eq(qualityScoutFindings.workspaceId, workspaceId), eq(qualityScoutFindings.signature, signature))))[0];

// ── claimRun ────────────────────────────────────────────────────────────────

describe('claimRun: one winner per run id', () => {
  const staleBefore = () => new Date(Date.now() - 20 * 60_000);

  test('two concurrent takers of a new run id: exactly one claims it', async () => {
    const { workspaceId } = await seedWorkspace();
    const r = scoutRun(workspaceId);
    const results = await Promise.all([
      dbScoutRunLedger.claimRun(r, staleBefore()),
      dbScoutRunLedger.claimRun({ ...r, trigger: 'periodic' }, staleBefore()),
    ]);
    expect(results.sort()).toEqual(['claimed', 'duplicate']);
    expect(await runRow(r.id)).toBeDefined();
  });

  test('two concurrent takers of a failed run: exactly one takes it over', async () => {
    const { workspaceId } = await seedWorkspace();
    const r = scoutRun(workspaceId, { status: 'failed', error: 'host died', startedAt: new Date(Date.now() - HOUR).toISOString() });
    await saveScoutRun(r);
    const fresh = { ...r, status: 'running' as const, error: null, startedAt: new Date().toISOString() };
    const results = await Promise.all([1, 2, 3].map(() => dbScoutRunLedger.claimRun(fresh, staleBefore())));
    expect(results.filter(x => x === 'claimed')).toHaveLength(1);
    expect(await runRow(r.id)).toMatchObject({ status: 'running', error: null });
  });

  test('a failed run is taken over: reset, and only its own probes are dropped', async () => {
    const { workspaceId } = await seedWorkspace();
    const failed = scoutRun(workspaceId, { status: 'failed', error: 'boom' });
    const sibling = scoutRun(workspaceId, { status: 'failed', error: 'other', candidate: { ref: 'main', sha: SHA2 } });
    await saveScoutRun(failed, undefined, { stages: [] } as never);
    await saveScoutRun(sibling);
    await saveScoutProbes(failed, [scoutProbeRecord(candidate(), SELECTED)]);
    await saveScoutProbes(sibling, [scoutProbeRecord(candidate(), SELECTED)]);

    const retry = { ...failed, status: 'running' as const, error: null, startedAt: new Date().toISOString() };
    expect(await dbScoutRunLedger.claimRun(retry, staleBefore())).toBe('claimed');
    expect(await runRow(failed.id)).toMatchObject({ status: 'running', error: null, metrics: null });
    expect(await probeCount(failed.id)).toBe(0);
    // The takeover is by id: a different failed run in the same workspace is not touched.
    expect(await runRow(sibling.id)).toMatchObject({ status: 'failed', error: 'other', candidateSha: SHA2 });
    expect(await probeCount(sibling.id)).toBe(1);
  });

  test('a running row older than staleBefore is taken over; a live one is not', async () => {
    const { workspaceId } = await seedWorkspace();
    const stale = scoutRun(workspaceId, { startedAt: new Date(Date.now() - HOUR).toISOString() });
    const live = scoutRun(workspaceId, { startedAt: new Date(Date.now() - 60_000).toISOString() });
    await saveScoutRun(stale);
    await saveScoutRun(live);
    await saveScoutProbes(live, [scoutProbeRecord(candidate(), SELECTED)]);
    const liveStartedAt = (await runRow(live.id)).startedAt.getTime();

    const now = new Date().toISOString();
    expect(await dbScoutRunLedger.claimRun({ ...stale, startedAt: now }, staleBefore())).toBe('claimed');
    expect((await runRow(stale.id)).startedAt.getTime()).toBe(new Date(now).getTime());

    expect(await dbScoutRunLedger.claimRun({ ...live, trigger: 'periodic', startedAt: now }, staleBefore())).toBe('duplicate');
    const after = await runRow(live.id);
    expect(after.startedAt.getTime()).toBe(liveStartedAt);
    expect(after.trigger).toBe('manual');
    expect(await probeCount(live.id)).toBe(1);
  });

  test('a completed run is never taken over', async () => {
    const { workspaceId } = await seedWorkspace();
    const done = scoutRun(workspaceId, { status: 'completed', startedAt: new Date(Date.now() - 2 * HOUR).toISOString(), completedAt: new Date(Date.now() - HOUR).toISOString() });
    await saveScoutRun(done);
    expect(await dbScoutRunLedger.claimRun({ ...done, status: 'running', completedAt: null, startedAt: new Date().toISOString() }, staleBefore())).toBe('duplicate');
    expect((await runRow(done.id)).status).toBe('completed');
  });
});

// ── Findings ────────────────────────────────────────────────────────────────

describe('findings are keyed by (workspace, signature)', () => {
  test('the same failure in two workspaces is two rows; a recurrence in one never touches the other', async () => {
    const a = (await seedWorkspace()).workspaceId;
    const b = (await seedWorkspace()).workspaceId;
    const c = candidate();
    const pa = executed(scoutRun(a), c, 'fail');
    const pb = executed(scoutRun(b), c, 'fail');
    const sig = pa.result!.signature;
    expect(pb.result!.signature).toBe(sig);

    const ra1 = scoutRun(a);
    const rb1 = scoutRun(b);
    expect(await recordScoutFailure(ra1, pa)).toBe('created');
    expect(await recordScoutFailure(rb1, pb)).toBe('created');
    // Same run twice is a no-op, not a second occurrence.
    expect(await recordScoutFailure(ra1, pa)).toBe('unchanged');

    const ra2 = scoutRun(a, { candidate: { ref: 'main', sha: SHA2 } });
    expect(await recordScoutFailure(ra2, pa)).toBe('recurred');

    expect(await finding(a, sig)).toMatchObject({ occurrenceCount: 2, lastSeenRunId: ra2.id, lastSeenSha: SHA2 });
    expect(await finding(b, sig)).toMatchObject({ occurrenceCount: 1, lastSeenRunId: rb1.id, lastSeenSha: SHA });
    const rows = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM quality_scout_findings WHERE signature = ${sig} AND workspace_id IN (${a}::uuid, ${b}::uuid)`);
    expect(rows[0].n).toBe(2);
  });

  test('insert dedupes within a workspace only', async () => {
    const a = (await seedWorkspace()).workspaceId;
    const b = (await seedWorkspace()).workspaceId;
    const c = candidate();
    const ra = scoutRun(a);
    const p = executed(ra, c, 'fail');
    await recordScoutFailure(ra, p);
    const fa = (await dbScoutFindingStore.find(a, p.result!.signature))!;
    expect(await dbScoutFindingStore.insert({ ...fa, occurrenceCount: 9 })).toBe(false);
    expect((await finding(a, fa.signature)).occurrenceCount).toBe(1);
    expect(await dbScoutFindingStore.insert({ ...fa, workspaceId: b })).toBe(true);
  });

  test('the compare-and-set update cannot reach another workspace\'s row with the same signature and count', async () => {
    const a = (await seedWorkspace()).workspaceId;
    const b = (await seedWorkspace()).workspaceId;
    const c = candidate();
    const ra = scoutRun(a);
    const rb = scoutRun(b);
    await recordScoutFailure(ra, executed(ra, c, 'fail'));
    await recordScoutFailure(rb, executed(rb, c, 'fail'));
    const sig = executed(ra, c, 'fail').result!.signature;
    const fa = (await dbScoutFindingStore.find(a, sig))!;

    const later = crypto.randomUUID();
    expect(await dbScoutFindingStore.update({ ...fa, occurrenceCount: 2, lastSeenRunId: later, observed: 'only a' }, 1)).toBe(true);
    expect(await finding(a, sig)).toMatchObject({ occurrenceCount: 2, lastSeenRunId: later, observed: 'only a' });
    expect(await finding(b, sig)).toMatchObject({ occurrenceCount: 1, lastSeenRunId: rb.id });
    expect((await finding(b, sig)).observed).not.toBe('only a');
  });

  test('a dismissal, an action-state raise and a pass resolve in one workspace leave the other\'s row alone', async () => {
    const a = (await seedWorkspace()).workspaceId;
    const b = (await seedWorkspace()).workspaceId;
    const c = candidate();
    const ra = scoutRun(a);
    const rb = scoutRun(b);
    const fail = executed(ra, c, 'fail');
    await recordScoutFailure(ra, fail);
    await recordScoutFailure(rb, executed(rb, c, 'fail'));
    const sig = fail.result!.signature;

    expect(await dbScoutActionStore.raiseActionState(a, sig, 'proposed')).toBe(true);
    expect((await finding(b, sig)).actionState).toBe('none');

    const resolved = await resolveScoutFindingsForPass(scoutRun(a), executed(ra, c, 'pass'));
    expect(resolved.map(r => r.signature)).toEqual([sig]);
    expect((await finding(a, sig)).state).toBe('resolved');
    expect((await finding(b, sig)).state).toBe('open');

    const d = scoutDismissal({ reason: 'expected', by: 'user:u-1', now: new Date() });
    if (!d.ok) throw new Error(d.error);
    expect((await dismissScoutFindingRow(b, sig, d.fields)).dismissed).toBe(true);
    expect((await finding(a, sig)).state).toBe('resolved');
  });
});

describe('a dismissed finding stays dismissed', () => {
  test('a later failing run only counts it; a later pass does not resolve it', async () => {
    const { workspaceId } = await seedWorkspace();
    const c = candidate();
    const r1 = scoutRun(workspaceId);
    const p = executed(r1, c, 'fail');
    const sig = p.result!.signature;
    await recordScoutFailure(r1, p);
    const d = scoutDismissal({ reason: 'expected behaviour', by: 'user:u-1', now: new Date() });
    if (!d.ok) throw new Error(d.error);
    await dismissScoutFindingRow(workspaceId, sig, d.fields);

    const r2 = scoutRun(workspaceId, { candidate: { ref: 'main', sha: SHA2 } });
    expect(await recordScoutFailure(r2, executed(r2, c, 'fail'))).toBe('recurred');
    expect(await finding(workspaceId, sig)).toMatchObject({
      state: 'dismissed', dismissedReason: 'expected behaviour', dismissedBy: 'user:u-1', occurrenceCount: 2, lastSeenRunId: r2.id,
    });

    const r3 = scoutRun(workspaceId);
    expect(await resolveScoutFindingsForPass(r3, executed(r3, c, 'pass'))).toEqual([]);
    expect((await finding(workspaceId, sig)).state).toBe('dismissed');
    expect(await dbScoutActionStore.raiseActionState(workspaceId, sig, 'retained')).toBe(false);
  });
});

describe('claimFollowUp', () => {
  test('concurrent claims for one finding: exactly one task wins', async () => {
    const { workspaceId } = await seedWorkspace();
    const r = scoutRun(workspaceId);
    const p = executed(r, candidate(), 'fail');
    await recordScoutFailure(r, p);
    const sig = p.result!.signature;
    const ids = await Promise.all([1, 2, 3].map(() => seedTask(workspaceId)));
    const won = await Promise.all(ids.map(id => dbScoutActionStore.claimFollowUp(workspaceId, sig, id, [])));
    expect(won.filter(Boolean)).toHaveLength(1);
    expect((await finding(workspaceId, sig)).actionTaskId).toBe(ids[won.indexOf(true)]);
  });

  test('a claim in one workspace never fills another workspace\'s finding', async () => {
    const a = (await seedWorkspace()).workspaceId;
    const b = (await seedWorkspace()).workspaceId;
    const c = candidate();
    const ra = scoutRun(a);
    const rb = scoutRun(b);
    const p = executed(ra, c, 'fail');
    await recordScoutFailure(ra, p);
    await recordScoutFailure(rb, executed(rb, c, 'fail'));
    const sig = p.result!.signature;
    const t = await seedTask(a);
    expect(await dbScoutActionStore.claimFollowUp(a, sig, t, [])).toBe(true);
    expect(await finding(b, sig)).toMatchObject({ actionTaskId: null, actionState: 'none' });
    // And b's claim is still free.
    expect(await dbScoutActionStore.claimFollowUp(b, sig, await seedTask(b), [])).toBe(true);
  });
});

// ── retireFollowUp ──────────────────────────────────────────────────────────

describe('retireFollowUp touches only its own task', () => {
  const resolvedWhy = { resolved: { resolvedRunId: crypto.randomUUID(), resolvedSha: SHA2 } };
  const taskRow = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
  /** A follow-up carries `context.qualityScout` from insert (dbScoutActionStore.insertTask); the retire marks inside it. */
  async function seedFollowUp(workspaceId: string, status = 'pending'): Promise<string> {
    const id = await seedTask(workspaceId, { status });
    await db.update(tasks).set({ context: { qualityScout: { signature: `sig-${id}`, runId: crypto.randomUUID(), missionId: null, followUp: 'fix' } } }).where(eq(tasks.id, id));
    return id;
  }
  const marked = (row: { context: unknown }) => (row.context as { qualityScout?: { resolved?: unknown } } | null)?.qualityScout?.resolved;

  test('an unclaimed follow-up is cancelled and marked; a pending sibling is not', async () => {
    const { workspaceId } = await seedWorkspace();
    const own = await seedFollowUp(workspaceId);
    const sibling = await seedFollowUp(workspaceId);
    expect(await dbScoutActionStore.retireFollowUp(own, resolvedWhy)).toBe('cancelled');
    const o = await taskRow(own);
    expect(o.status).toBe('cancelled');
    expect(marked(o)).toEqual(resolvedWhy.resolved);
    expect(await dbScoutActionStore.cancelledByScout(own)).toBe(true);
    const s = await taskRow(sibling);
    expect(s.status).toBe('pending');
    expect(marked(s)).toBeUndefined();
  });

  test('a started follow-up is annotated and deprioritised, not cancelled; an active sibling is not', async () => {
    const { workspaceId } = await seedWorkspace();
    const own = await seedFollowUp(workspaceId, 'in_progress');
    const sibling = await seedFollowUp(workspaceId, 'in_progress');
    await db.update(tasks).set({ priority: 9 }).where(sql`${tasks.id} IN (${own}::uuid, ${sibling}::uuid)`);
    expect(await dbScoutActionStore.retireFollowUp(own, resolvedWhy)).toBe('annotated');
    const o = await taskRow(own);
    expect(o.status).toBe('in_progress');
    expect(o.priority).toBeLessThan(9);
    expect(marked(o)).toEqual(resolvedWhy.resolved);
    const s = await taskRow(sibling);
    expect(s.priority).toBe(9);
    expect(marked(s)).toBeUndefined();
  });

  test('a finished follow-up is left as it is', async () => {
    const { workspaceId } = await seedWorkspace();
    const own = await seedFollowUp(workspaceId, 'completed');
    expect(await dbScoutActionStore.retireFollowUp(own, resolvedWhy)).toBeNull();
    expect((await taskRow(own)).status).toBe('completed');
  });
});

// ── Periodic sweep ──────────────────────────────────────────────────────────

describe('periodic sweep', () => {
  async function workspaceWith(qualityScout: unknown): Promise<string> {
    const { workspaceId } = await seedWorkspace();
    await db.execute(sql`UPDATE workspaces SET git_config = ${qualityScout === undefined ? null : JSON.stringify({ qualityScout })}::jsonb WHERE id = ${workspaceId}::uuid`);
    return workspaceId;
  }

  // The listing, the last-run read and the run-row lookup are the real SQL;
  // only the repo and its head (GitHub) are stood in for.
  const HEAD = 'c'.repeat(40);
  const deps: PeriodicScoutDeps = {
    ...dbPeriodicScoutDeps,
    loadWorkspace: async (id) => ({
      id, teamId: id, gitConfig: null, configStatus: 'admin_confirmed', releaseConfig: null,
      githubRepo: { fullName: 'example/repo', defaultBranch: 'main', installation: { installationId: 1 } },
    }),
    headSha: async () => HEAD,
  };
  const sweep = (now: Date) => runPeriodicQualityScouts(now, { maxWorkspaces: 100_000, schedule: () => {}, deps, env: {} });

  test('schedules only opted-in workspaces that are due, judged by each workspace\'s own last run', async () => {
    const now = new Date();
    const periodic = { mode: 'shadow', triggers: { periodicHours: 6 } };
    const neverRan = await workspaceWith(periodic);
    const ranLongAgo = await workspaceWith(periodic);
    const ranRecently = await workspaceWith(periodic);
    const modeOff = await workspaceWith({ mode: 'off', triggers: { periodicHours: 6 } });
    const noPeriodic = await workspaceWith({ mode: 'shadow' });
    const noConfig = await workspaceWith(undefined);
    const badHours = await workspaceWith({ mode: 'shadow', triggers: { periodicHours: 0 } });

    await saveScoutRun(scoutRun(ranLongAgo, { status: 'completed', startedAt: new Date(now.getTime() - 7 * HOUR).toISOString() }));
    await saveScoutRun(scoutRun(ranRecently, { status: 'completed', startedAt: new Date(now.getTime() - HOUR).toISOString() }));
    // Recent runs elsewhere must not make ranLongAgo look fresh.
    await saveScoutRun(scoutRun(noPeriodic, { startedAt: now.toISOString() }));

    const listed = new Set((await dbPeriodicScoutDeps.listConfigured()).map(r => r.id));
    expect([neverRan, ranLongAgo, ranRecently, modeOff, badHours].every(id => listed.has(id))).toBe(true);
    expect(listed.has(noPeriodic) || listed.has(noConfig)).toBe(false);

    const out = await sweep(now);
    const mine = new Set([neverRan, ranLongAgo, ranRecently, modeOff, noPeriodic, noConfig, badHours]);
    expect(out.scheduled.filter(id => mine.has(id)).sort()).toEqual([neverRan, ranLongAgo].sort());
    expect(out.errors).toBe(0);
  });

  test('a head that already has its automatic run is passed over; a failed one is owed again', async () => {
    const now = new Date();
    const periodic = { mode: 'shadow', triggers: { periodicHours: 6 } };
    const exercised = await workspaceWith(periodic);
    const failedHead = await workspaceWith(periodic);
    const old = new Date(now.getTime() - 7 * HOUR).toISOString();
    await saveScoutRun(scoutRun(exercised, { id: scoutRunId(exercised, 'periodic', HEAD), trigger: 'periodic', status: 'completed', startedAt: old, candidate: { ref: 'main', sha: HEAD } }));
    await saveScoutRun(scoutRun(failedHead, { id: scoutRunId(failedHead, 'periodic', HEAD), trigger: 'periodic', status: 'failed', startedAt: old, candidate: { ref: 'main', sha: HEAD } }));

    const out = await sweep(now);
    expect(out.scheduled).toContain(failedHead);
    expect(out.scheduled).not.toContain(exercised);
  });
});
