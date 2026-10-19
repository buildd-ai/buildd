/**
 * What the schedules tick decides, on real Postgres (Living Spec "Fast at any
 * size", R-25). The tick now reads only the keys and rows its checks need
 * (cron-schedules-budget.test.ts measures that); this file pins that every
 * schedule, mission and task it acted on before is still acted on, and
 * nothing else:
 *
 *  - overdue check-ins: which heartbeats alert, and which mission they name;
 *  - the done-mission archive: which missions it archives;
 *  - the heartbeat prepass: each decision it reaches from a task's context
 *    and result (budget pause, infra retry, the last cycle's budget wall, the
 *    PR count, no change);
 *  - the completion gate: an infrastructure-stalled deliverable still blocks.
 *
 * Each runs against rows whose context and result carry far more than the
 * read keys, so a missing key fails here rather than in production.
 */
import { describe, it, expect, beforeAll, mock } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

assertDbConfigured();

const notified: string[] = [];
mock.module('../../src/lib/pushover', () => ({
  notifyOperator: (o: { title: string }) => { notified.push(o.title); },
  sendPushover: async () => false,
}));

const { runOverdueHeartbeatAlerts } = await import('../../src/app/api/cron/schedules/maintenance/overdue-heartbeats');
const { archiveStaleDoneMissions } = await import('../../src/lib/mission-archive');
const { evaluateHeartbeatPrepass } = await import('../../src/lib/heartbeat-prepass');
const { canCompleteMission, COMPLETION_CONTEXT_KEYS } = await import('../../src/lib/mission-completion');
const { DELIVERABLE_ROLE_CONTEXT_KEYS } = await import('@buildd/core/mission-helpers');

const HOUR = 3_600_000;
const BULK = 'x'.repeat(4000);

let teamId: string;
let workspaceId: string;

beforeAll(async () => {
  ({ teamId, workspaceId } = await seedWorkspace());
});

async function mission(opts: { status?: string; updatedAgoMs?: number; goalCriteria?: unknown; goalCriteriaState?: unknown; scheduleId?: string | null } = {}): Promise<string> {
  const [m] = await q<{ id: string }>(sql`
    INSERT INTO missions (team_id, workspace_id, title, status, updated_at, goal_criteria, goal_criteria_state, schedule_id)
    VALUES (${teamId}::uuid, ${workspaceId}::uuid, ${`sel-m-${Math.random().toString(36).slice(2)}`}, ${opts.status ?? 'active'},
      ${new Date(Date.now() - (opts.updatedAgoMs ?? 0)).toISOString()}::timestamptz,
      ${opts.goalCriteria === undefined ? null : JSON.stringify(opts.goalCriteria)}::jsonb,
      ${opts.goalCriteriaState === undefined ? null : JSON.stringify(opts.goalCriteriaState)}::jsonb,
      ${opts.scheduleId ?? null}::uuid)
    RETURNING id`);
  return m.id;
}

async function task(missionId: string, opts: {
  status?: string; mode?: string; taskClass?: string; title?: string; updatedAgoMs?: number; createdAgoMs?: number;
  context?: Record<string, unknown> | null; result?: Record<string, unknown> | null; startAt?: Date | null;
}): Promise<string> {
  const [t] = await q<{ id: string }>(sql`
    INSERT INTO tasks (workspace_id, mission_id, title, status, mode, task_class, context, result, start_at, created_at, updated_at)
    VALUES (${workspaceId}::uuid, ${missionId}::uuid, ${opts.title ?? `sel-t-${Math.random().toString(36).slice(2)}`},
      ${opts.status ?? 'completed'}, ${opts.mode ?? 'execution'}, ${opts.taskClass ?? 'work'},
      ${opts.context === null ? null : JSON.stringify({ notes: BULK, ...(opts.context ?? {}) })}::jsonb,
      ${opts.result === null || opts.result === undefined ? null : JSON.stringify({ summary: BULK, ...opts.result })}::jsonb,
      ${opts.startAt?.toISOString() ?? null}::timestamptz,
      ${new Date(Date.now() - (opts.createdAgoMs ?? opts.updatedAgoMs ?? 0)).toISOString()}::timestamptz,
      ${new Date(Date.now() - (opts.updatedAgoMs ?? 0)).toISOString()}::timestamptz)
    RETURNING id`);
  return t.id;
}

async function schedule(opts: {
  heartbeat?: unknown; enabled?: boolean; nextRunAgoMs: number; lastOverdueAlertAgoMs?: number;
}): Promise<string> {
  const context: Record<string, unknown> = { notes: BULK };
  if (opts.heartbeat !== undefined) context.heartbeat = opts.heartbeat;
  const [s] = await q<{ id: string }>(sql`
    INSERT INTO task_schedules (workspace_id, name, cron_expression, task_template, enabled, next_run_at, last_overdue_alert_at)
    VALUES (${workspaceId}::uuid, ${`sel-s-${Math.random().toString(36).slice(2)}`}, '0 * * * *',
      ${JSON.stringify({ title: 'Check-in', description: BULK, context })}::jsonb, ${opts.enabled ?? true},
      ${new Date(Date.now() - opts.nextRunAgoMs).toISOString()}::timestamptz,
      ${opts.lastOverdueAlertAgoMs === undefined ? null : new Date(Date.now() - opts.lastOverdueAlertAgoMs).toISOString()}::timestamptz)
    RETURNING id`);
  return s.id;
}

describe('overdue check-ins', () => {
  it('alerts exactly the overdue heartbeats past their rate limit, naming the linked mission', async () => {
    const linked = await schedule({ heartbeat: true, nextRunAgoMs: 72 * HOUR });
    const linkedMission = await mission({ scheduleId: linked });
    const unlinked = await schedule({ heartbeat: true, nextRunAgoMs: 72 * HOUR });
    const plain = await schedule({ heartbeat: false, nextRunAgoMs: 72 * HOUR });
    const noFlag = await schedule({ nextRunAgoMs: 72 * HOUR });
    const stringFlag = await schedule({ heartbeat: 'true', nextRunAgoMs: 72 * HOUR });
    const disabled = await schedule({ heartbeat: true, enabled: false, nextRunAgoMs: 72 * HOUR });
    const withinTolerance = await schedule({ heartbeat: true, nextRunAgoMs: HOUR / 2 });
    const alertedRecently = await schedule({ heartbeat: true, nextRunAgoMs: 72 * HOUR, lastOverdueAlertAgoMs: 10 * 60_000 });
    const alertedLongAgo = await schedule({ heartbeat: true, nextRunAgoMs: 72 * HOUR, lastOverdueAlertAgoMs: 2 * HOUR });

    notified.length = 0;
    const now = new Date();
    await runOverdueHeartbeatAlerts(now);

    const mine = (id: string) => notified.some(t => t.includes(id));
    expect(notified).toContain(`Check-in overdue: mission ${linkedMission}`);
    expect(mine(linked)).toBe(false);
    expect(notified).toContain(`Check-in overdue: schedule ${unlinked}`);
    expect(notified).toContain(`Check-in overdue: schedule ${alertedLongAgo}`);
    for (const id of [plain, noFlag, stringFlag, disabled, withinTolerance, alertedRecently]) expect(mine(id)).toBe(false);

    const stamped = await q<{ id: string; at: string | null }>(sql`
      SELECT id, last_overdue_alert_at AS at FROM task_schedules
      WHERE id IN (${linked}::uuid, ${unlinked}::uuid, ${alertedLongAgo}::uuid, ${plain}::uuid, ${alertedRecently}::uuid)`);
    const at = new Map(stamped.map(r => [r.id, r.at ? new Date(r.at).getTime() : null]));
    for (const id of [linked, unlinked, alertedLongAgo]) expect(at.get(id)).toBe(now.getTime());
    expect(at.get(plain)).toBeNull();
    expect(at.get(alertedRecently)).not.toBe(now.getTime());

    // Stamped: the next tick inside the interval stays quiet.
    notified.length = 0;
    await runOverdueHeartbeatAlerts(new Date());
    for (const id of [linkedMission, unlinked, alertedLongAgo]) expect(mine(id)).toBe(false);
  });
});

describe('done-mission archive', () => {
  it('archives exactly the active, all-completed missions quiet for a day', async () => {
    const quiet = 30 * HOUR;
    const done = await mission({ updatedAgoMs: quiet });
    await task(done, { updatedAgoMs: quiet });
    await task(done, { updatedAgoMs: 26 * HOUR });

    const recentTask = await mission({ updatedAgoMs: quiet });
    await task(recentTask, { updatedAgoMs: quiet });
    await task(recentTask, { updatedAgoMs: 2 * HOUR });

    const recentMission = await mission({ updatedAgoMs: 2 * HOUR });
    await task(recentMission, { updatedAgoMs: quiet });

    const oneFailed = await mission({ updatedAgoMs: quiet });
    await task(oneFailed, { updatedAgoMs: quiet });
    await task(oneFailed, { status: 'failed', updatedAgoMs: quiet });

    const noTasks = await mission({ updatedAgoMs: quiet });
    const paused = await mission({ status: 'paused', updatedAgoMs: quiet });
    await task(paused, { updatedAgoMs: quiet });

    const unverified = await mission({ updatedAgoMs: quiet, goalCriteria: [{ id: 'gc-1', type: 'no_open_tasks' }], goalCriteriaState: { overall: 'fail' } });
    await task(unverified, { updatedAgoMs: quiet });
    const neverEvaluated = await mission({ updatedAgoMs: quiet, goalCriteria: [{ id: 'gc-1', type: 'no_open_tasks' }] });
    await task(neverEvaluated, { updatedAgoMs: quiet });
    const verified = await mission({ updatedAgoMs: quiet, goalCriteria: [{ id: 'gc-1', type: 'no_open_tasks' }], goalCriteriaState: { overall: 'pass' } });
    await task(verified, { updatedAgoMs: quiet });
    const emptyCriteria = await mission({ updatedAgoMs: quiet, goalCriteria: [], goalCriteriaState: { overall: 'fail' } });
    await task(emptyCriteria, { updatedAgoMs: quiet });

    const enabledSched = await schedule({ heartbeat: true, nextRunAgoMs: -HOUR });
    const scheduled = await mission({ updatedAgoMs: quiet, scheduleId: enabledSched });
    await task(scheduled, { updatedAgoMs: quiet });
    const disabledSched = await schedule({ heartbeat: true, enabled: false, nextRunAgoMs: -HOUR });
    const disabledScheduled = await mission({ updatedAgoMs: quiet, scheduleId: disabledSched });
    await task(disabledScheduled, { updatedAgoMs: quiet });

    const archived = new Set(await archiveStaleDoneMissions(new Date()));
    for (const id of [done, verified, emptyCriteria, disabledScheduled]) expect(archived.has(id)).toBe(true);
    for (const id of [recentTask, recentMission, oneFailed, noTasks, paused, unverified, neverEvaluated, scheduled]) expect(archived.has(id)).toBe(false);

    const rows = await q<{ id: string; status: string; schedule_id: string | null }>(sql`
      SELECT id, status, schedule_id FROM missions WHERE id IN (${done}::uuid, ${disabledScheduled}::uuid, ${scheduled}::uuid)`);
    const byId = new Map(rows.map(r => [r.id, r]));
    expect(byId.get(done)!.status).toBe('archived');
    expect(byId.get(disabledScheduled)!.schedule_id).toBeNull();
    expect(byId.get(scheduled)!.status).toBe('active');
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM task_schedules WHERE id = ${disabledSched}::uuid`);
    expect(n).toBe(0);
  });
});

describe('heartbeat prepass', () => {
  const input = (missionId: string, lastHeartbeatStateHash: string | null = null) => ({
    missionId, dependsOnMissionId: null, gateCondition: 'merged' as const, dependencyMetAt: null, lastHeartbeatStateHash,
  });
  const inAnHour = () => new Date(Date.now() + HOUR);

  it('waits on a provider budget pause read from the task context', async () => {
    const m = await mission();
    await task(m, {});
    const until = inAnHour();
    await task(m, { status: 'pending', context: { budgetExhausted: true }, startAt: until });
    const d = await evaluateHeartbeatPrepass(input(m));
    expect(d).toMatchObject({ action: 'skip_waiting', reason: 'provider budget/rate-limit pause' });
    expect((d as { waitUntil: Date }).waitUntil.getTime()).toBe(until.getTime());
  });

  it('waits on an infrastructure retry read from the task context', async () => {
    const m = await mission();
    await task(m, {});
    await task(m, { status: 'pending', context: { infraRetryCount: 2 }, startAt: inAnHour() });
    expect(await evaluateHeartbeatPrepass(input(m))).toMatchObject({ action: 'skip_waiting', reason: 'infrastructure failure, automatic retry scheduled' });
  });

  it('a flag that is not the literal one does not wait', async () => {
    const m = await mission();
    await task(m, {});
    await task(m, { status: 'pending', context: { budgetExhausted: 'true', infraRetryCount: '2' }, startAt: inAnHour() });
    expect((await evaluateHeartbeatPrepass(input(m))).action).toBe('invoke_llm');
  });

  it('waits on the last cycle\'s budget wall read from its result, weekly window from its error text', async () => {
    const m = await mission();
    await task(m, { status: 'in_progress' });
    await task(m, {
      mode: 'planning', taskClass: 'bookkeeping', status: 'failed', createdAgoMs: 60_000,
      result: { errorType: 'budget_limited', error: 'usage limit reached' },
    });
    expect(await evaluateHeartbeatPrepass(input(m))).toMatchObject({ action: 'skip_waiting', reason: 'provider budget/rate-limit pause (organizer run)' });

    // Six hours on, a session wall has lifted; a weekly one (named in `error`) has not.
    const session = await mission();
    await task(session, { status: 'in_progress' });
    await task(session, { mode: 'planning', taskClass: 'bookkeeping', status: 'failed', createdAgoMs: 6 * HOUR, result: { errorType: 'budget_limited', error: 'usage limit reached' } });
    expect((await evaluateHeartbeatPrepass(input(session))).action).toBe('invoke_llm');
    const weekly = await mission();
    await task(weekly, { status: 'in_progress' });
    await task(weekly, { mode: 'planning', taskClass: 'bookkeeping', status: 'failed', createdAgoMs: 6 * HOUR, result: { errorType: 'budget_limited', error: 'You have hit your weekly limit' } });
    expect((await evaluateHeartbeatPrepass(input(weekly))).action).toBe('skip_waiting');
  });

  it('a failed last cycle that was not a budget wall does not wait', async () => {
    const m = await mission();
    await task(m, { status: 'in_progress' });
    await task(m, { mode: 'planning', taskClass: 'bookkeeping', status: 'failed', createdAgoMs: 60_000, result: { errorType: 'other', error: 'boom' } });
    expect((await evaluateHeartbeatPrepass(input(m))).action).toBe('invoke_llm');
  });

  it('counts a PR recorded in a task result, so an unchanged state still plans', async () => {
    const m = await mission();
    await task(m, { result: { prUrl: 'https://github.com/example/fixture/pull/7' } });
    await task(m, { status: 'in_progress', result: null });
    const d = await evaluateHeartbeatPrepass(input(m));
    expect(d).toMatchObject({ action: 'invoke_llm', stateKey: 'c1a1f0ar0pr1n0' });
    // Same state hash, but an open PR: still plans.
    expect((await evaluateHeartbeatPrepass(input(m, 'c1a1f0ar0pr1n0'))).action).toBe('invoke_llm');
  });

  it('skips an unchanged mission with no PR, and proposes completion when every deliverable is done', async () => {
    const m = await mission();
    await task(m, { result: { prUrl: null } });
    await task(m, { status: 'in_progress', result: null, context: null });
    const d = await evaluateHeartbeatPrepass(input(m));
    expect(d).toMatchObject({ action: 'invoke_llm', stateKey: 'c1a1f0ar0pr0n0' });
    expect(await evaluateHeartbeatPrepass(input(m, 'c1a1f0ar0pr0n0'))).toMatchObject({ action: 'skip_no_change' });

    const finished = await mission();
    await task(finished, {});
    await task(finished, { status: 'failed' });
    expect((await evaluateHeartbeatPrepass(input(finished))).action).toBe('skip_complete');
  });
});

describe('completion gate', () => {
  it('reads every context key that says what kind of deliverable a row is', () => {
    expect([...COMPLETION_CONTEXT_KEYS].sort()).toEqual(
      [...DELIVERABLE_ROLE_CONTEXT_KEYS.values, ...DELIVERABLE_ROLE_CONTEXT_KEYS.objectMarkers].sort(),
    );
  });

  it('still refuses a mission whose deliverable stalled on infrastructure, and passes a plain done one', async () => {
    const stalled = await mission();
    await task(stalled, {});
    await task(stalled, { status: 'failed', title: 'Stalled deliverable', result: { errorType: 'infra_stalled' } });
    const d = await canCompleteMission(stalled, { evaluateCriteria: false });
    expect(d).toMatchObject({ ok: false, code: 'infra_stalled' });
    expect((d as { infraStalledTitles: string[] }).infraStalledTitles).toEqual(['Stalled deliverable']);

    const otherFailure = await mission();
    await task(otherFailure, {});
    await task(otherFailure, { status: 'failed', result: { errorType: 'agent_error' } });
    expect((await canCompleteMission(otherFailure, { evaluateCriteria: false })).code).not.toBe('infra_stalled');

    const done = await mission();
    await task(done, {});
    expect(await canCompleteMission(done, { evaluateCriteria: false })).toMatchObject({ ok: true });
  });
});
