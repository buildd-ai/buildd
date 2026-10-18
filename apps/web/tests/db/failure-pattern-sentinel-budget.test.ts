/**
 * The failure-pattern sentinel's cron run against its budget (Living Spec
 * "Fast at any size", R-25) on a real database.
 *
 * R-25: a scheduled job reads only what changed since its last run, or a
 * bounded batch, and no single run reads more than 5 MB. The sweep used to
 * run its whole fact collection (about fifteen queries) for every workspace
 * with a repo, every 30 minutes, whether or not anything had happened there.
 *
 * Seeded: the large synthetic team (its three workspaces given a repo), many
 * quiet workspaces whose history is all older than every window, and one
 * workspace per kind of fact the sentinel reads. Measured: a steady-state
 * full sweep (after a first sweep has opened the incidents and advanced the
 * watermarks), the way the 30-minute backstop runs.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q } from './harness';
import { measureLoader, reportBudget, seedLargeTeam, seedScale, type SeededTeam } from './budget-harness';

assertDbConfigured();

const { runFailurePatternSweep, productionSweepDeps, dbSelectActiveWorkspaces, earliestSweepFloors, computeSweepFloors } =
  await import('../../src/lib/failure-pattern-sweep');
const { detectFailurePatterns } = await import('../../src/lib/failure-pattern-sentinel');

/**
 * R-25: a run reads at most 5 MB. Queries: the up-front reads and the run's
 * fixed tail, plus at most a sweep's worth per workspace with something to
 * find; a quiet workspace costs none of its own.
 *
 * The fixed part has headroom because the run's tail (the operator recovery
 * pass over decision records, open incidents) reads rows that other files in
 * a shared test database leave behind; in CI it measured well above a fresh
 * database. It still does not grow with quiet workspaces, which is the claim.
 */
const CRON_BYTES = 5 * 1024 * 1024;
const FIXED_QUERIES = 80;
const PER_ACTIVE_WORKSPACE = 16;
const QUIET_WORKSPACES = 80;

let team: SeededTeam;
const scale = seedScale();

beforeAll(async () => {
  team = await seedLargeTeam(scale);
  await q(sql`UPDATE workspaces SET repo = 'https://github.com/example/fixture' WHERE team_id = ${team.teamId}::uuid AND repo IS NULL`);
  const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM workspaces WHERE name LIKE 'fps-quiet-%'`);
  if (n < QUIET_WORKSPACES) {
    // Quiet: a repo, and a little history that is older than every window.
    await q(sql`
      WITH ws AS (
        INSERT INTO workspaces (name, team_id, repo)
        SELECT 'fps-quiet-' || g, ${team.teamId}::uuid, 'https://github.com/example/quiet-' || g
        FROM generate_series(${n + 1}::int, ${QUIET_WORKSPACES}::int) g RETURNING id
      ), t AS (
        INSERT INTO tasks (workspace_id, title, status, created_at, updated_at)
        SELECT id, 'old work', 'completed', now() - interval '30 days', now() - interval '30 days' FROM ws RETURNING id, workspace_id
      )
      INSERT INTO workers (task_id, workspace_id, name, runner, branch, status, created_at, completed_at, updated_at)
      SELECT id, workspace_id, 'w', 'r', 'b', 'completed', now() - interval '30 days', now() - interval '30 days', now() - interval '30 days' FROM t`);
  }
}, 900_000);

/**
 * One workspace per kind of row a sentinel rule reads, each just inside its
 * window, and near misses just outside. Returns the workspace id by kind.
 */
async function seedFactKinds(teamId: string): Promise<Record<string, string>> {
  const kinds = [
    'failedWorker', 'lateFailure', 'stranded', 'deferral', 'retry', 'held', 'stalled', 'auditFailed', 'auditWaiting', 'incident',
    'nearMissWorker', 'nearMissGate', 'nearMissRetry', 'resolvedIncident', 'releasedHoldElsewhere',
  ];
  const ids: Record<string, string> = {};
  // A re-run in the same database starts the kinds over, so every window is measured from now.
  await q(sql`DELETE FROM workspaces WHERE name LIKE 'fps-kind-%'`);
  for (const kind of kinds) {
    const [ws] = await q<{ id: string }>(sql`
      INSERT INTO workspaces (name, team_id, repo) VALUES (${`fps-kind-${kind}-${Date.now().toString(36)}`}, ${teamId}::uuid, 'https://github.com/example/kinds')
      RETURNING id`);
    ids[kind] = ws.id;
  }
  const task = async (kind: string, cols: { status?: string; title?: string; roleSlug?: string | null; context?: object; result?: object; ciRetryPr?: number | null; ago?: string }) => {
    const [t] = await q<{ id: string }>(sql`
      INSERT INTO tasks (workspace_id, title, status, role_slug, context, result, ci_retry_pr_number, created_at, updated_at)
      VALUES (${ids[kind]}::uuid, ${cols.title ?? 'kind task'}, ${cols.status ?? 'completed'}, ${cols.roleSlug ?? null},
        ${JSON.stringify(cols.context ?? {})}::jsonb, ${cols.result ? JSON.stringify(cols.result) : null}::jsonb, ${cols.ciRetryPr ?? null}::int,
        now() - ${cols.ago ?? '1 hour'}::interval, now() - ${cols.ago ?? '1 hour'}::interval)
      RETURNING id`);
    return t.id;
  };
  const worker = async (kind: string, taskId: string, status: string, createdAgo: string, completedAgo: string | null) => {
    await q(sql`
      INSERT INTO workers (task_id, workspace_id, name, runner, branch, status, error, created_at, completed_at, updated_at)
      VALUES (${taskId}::uuid, ${ids[kind]}::uuid, 'w', 'r', 'b', ${status}, 'Error: the check failed',
        now() - ${createdAgo}::interval, ${completedAgo === null ? null : sql`now() - ${completedAgo}::interval`}, now())`);
  };
  const gate = async (kind: string, cols: { gate: string; outcome: string; reason: string; taskId?: string | null; ago: string }) => {
    await q(sql`
      INSERT INTO gate_events (workspace_id, gate, surface, outcome, reason, task_id, detail, occurred_at)
      VALUES (${ids[kind]}::uuid, ${cols.gate}, 'test', ${cols.outcome}, ${cols.reason}, ${cols.taskId ?? null}::uuid, '{}'::jsonb, now() - ${cols.ago}::interval)`);
  };
  const incident = async (kind: string, status: string) => {
    await q(sql`
      INSERT INTO failure_incidents (workspace_id, signature, detector_version, rule, reason_code, title, severity, status, first_seen_at, last_seen_at)
      VALUES (${ids[kind]}::uuid, ${`sig-${kind}-${ids[kind]}`}, 'v1', 'path_overlap_stall', 'r', 't', 'medium', ${status}, now(), now())`);
  };

  await worker('failedWorker', await task('failedWorker', { status: 'failed' }), 'failed', '1 hour', '50 minutes');
  await worker('lateFailure', await task('lateFailure', { status: 'failed', ago: '3 days' }), 'error', '3 days', '10 minutes');
  await gate('stranded', { gate: 'merge_policy', outcome: 'stranded', reason: 'stuck', ago: '2 hours' });
  await gate('deferral', { gate: 'claim_loop_deferral', outcome: 'deferred', reason: 'path_overlap', taskId: await task('deferral', { status: 'pending' }), ago: '3 hours' });
  await task('retry', { status: 'completed', ciRetryPr: 41, ago: '2 days' });
  await task('held', { status: 'pending', ago: '20 days', context: { credentialHold: { credentialKey: 'team:claude', since: new Date().toISOString(), attempts: 1, shared: false, exhausted: false } } });
  await task('stalled', { status: 'failed', result: { errorType: 'infra_stalled' } });
  await task('auditFailed', { status: 'failed', roleSlug: 'visual-auditor', ago: '2 days' });
  await worker('auditWaiting', await task('auditWaiting', { status: 'in_progress', title: '[surface audit] home', ago: '20 days' }), 'waiting_input', '20 days', null);
  await incident('incident', 'open');
  // Near misses: just outside every window, so nothing to find.
  await worker('nearMissWorker', await task('nearMissWorker', { status: 'failed', ago: '2 days' }), 'failed', '2 days', '2 days');
  await gate('nearMissGate', { gate: 'merge_policy', outcome: 'stranded', reason: 'stuck', ago: '3 days' });
  await task('nearMissRetry', { status: 'completed', ciRetryPr: 41, ago: '9 days' });
  await incident('resolvedIncident', 'resolved');
  await task('releasedHoldElsewhere', { status: 'completed', ago: '1 hour', context: { credentialHold: { credentialKey: 'k', since: new Date().toISOString() } } });
  return ids;
}

function sweepDeps() {
  // No page and no model: the sentinel's database cost is what is measured.
  return { ...productionSweepDeps(), decide: null, send: async () => false };
}

describe('Failure pattern sentinel: the activity read misses nothing a rule finds (R-25)', () => {
  it('selects every workspace with a fact or an open incident, and every workspace it leaves out has nothing to find', async () => {
    const kinds = await seedFactKinds(team.teamId);
    const deps = productionSweepDeps();
    const all = (await q<{ id: string }>(sql`SELECT id FROM workspaces WHERE repo IS NOT NULL`)).map(r => r.id);
    const now = new Date().toISOString();
    const watermarks = await deps.getWatermarks!(all);
    const floors = earliestSweepFloors(all.map(id => watermarks.get(id) ?? null), now);
    const rules = [...new Set(deps.recovery!.families.map(f => f.rule))];
    const active = await dbSelectActiveWorkspaces(all, floors, now, rules);

    for (const kind of ['failedWorker', 'lateFailure', 'stranded', 'deferral', 'retry', 'held', 'stalled', 'auditFailed', 'auditWaiting']) {
      expect(active.facts.has(kinds[kind]), `${kind} is selected`).toBe(true);
    }
    expect(active.recovery.has(kinds.incident)).toBe(true);
    expect(active.recovery.has(kinds.resolvedIncident)).toBe(false);
    for (const kind of ['nearMissWorker', 'nearMissGate', 'nearMissRetry', 'resolvedIncident', 'releasedHoldElsewhere', 'incident']) {
      expect(active.facts.has(kinds[kind]), `${kind} is not selected for facts`).toBe(false);
    }

    // The collector agrees: each selected kind it reads yields its fact...
    const factsOf = (ws: string) => deps.collectFacts(ws, computeSweepFloors(watermarks.get(ws) ?? null, now), now);
    expect((await factsOf(kinds.failedWorker)).workerFailures?.length).toBe(1);
    expect((await factsOf(kinds.lateFailure)).failureRate?.recent.failed).toBe(1);
    expect((await factsOf(kinds.stranded)).gateEvents?.length).toBe(1);
    expect((await factsOf(kinds.deferral)).pathOverlapDeferrals?.length).toBe(1);
    expect((await factsOf(kinds.retry)).retryChildren?.length).toBe(1);
    expect((await factsOf(kinds.held)).workerInfra?.length).toBe(1);
    expect((await factsOf(kinds.stalled)).workerInfra?.length).toBe(1);
    // ...and every workspace left out collects nothing any rule fires on.
    const left = all.filter(id => !active.facts.has(id));
    expect(left.length).toBeGreaterThan(QUIET_WORKSPACES);
    for (const ws of left) {
      const f = await factsOf(ws);
      const lists = [f.workerFailures, f.gateEvents, f.pathOverlapDeferrals, f.retryChildren, f.lineages, f.workerInfra, f.captureFailures];
      expect(lists.every(l => (l ?? []).length === 0), `workspace ${ws.slice(0, 8)} has a fact`).toBe(true);
      expect(f.failureRate?.recent.failed ?? 0).toBe(0);
      expect(detectFailurePatterns(f)).toEqual([]);
    }
  }, 600_000);
});

describe('Failure pattern sentinel run budget', () => {
  it('fits R-25: a steady-state full sweep reads at most 5 MB, and quiet workspaces cost nothing', async () => {
    await seedFactKinds(team.teamId);
    // Before: the same sweep with the batched reads switched off reads every workspace.
    const perWorkspace = () => ({ ...sweepDeps(), getWatermarks: undefined, setWatermarks: undefined, selectActiveWorkspaces: undefined });
    await runFailurePatternSweep(perWorkspace());
    const before = await measureLoader('cron:failure-pattern-sentinel (per workspace)', () => runFailurePatternSweep(perWorkspace()));

    await runFailurePatternSweep(sweepDeps());
    const m = await measureLoader('cron:failure-pattern-sentinel', () => runFailurePatternSweep(sweepDeps()));

    const deps = productionSweepDeps();
    const all = (await q<{ id: string }>(sql`SELECT id FROM workspaces WHERE repo IS NOT NULL`)).map(r => r.id);
    const now = new Date().toISOString();
    const wm = await deps.getWatermarks!(all);
    const active = await dbSelectActiveWorkspaces(all, earliestSweepFloors(all.map(id => wm.get(id) ?? null), now), now,
      [...new Set(deps.recovery!.families.map(f => f.rule))]);
    const swept = new Set([...active.facts, ...active.recovery]).size;
    const budget = { queries: FIXED_QUERIES + PER_ACTIVE_WORKSPACE * swept, bytes: CRON_BYTES };
    reportBudget(before, { queries: 0, bytes: CRON_BYTES }, scale);
    reportBudget(m, budget, scale);
    process.stdout.write(`[budget] ${all.length} workspaces with a repo, ${swept} with something to find\n`);

    expect(m.count).toBeGreaterThan(0);
    expect(swept).toBeLessThan(all.length - QUIET_WORKSPACES + 1);
    expect(m.bytes).toBeLessThanOrEqual(CRON_BYTES);
    expect(m.count).toBeLessThanOrEqual(budget.queries);
    expect(m.count).toBeLessThan(before.count);
  }, 600_000);
});
