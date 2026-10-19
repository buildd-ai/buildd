/**
 * Ordinary work with an unknown file scope starts by default, on real Postgres
 * (docs/specs/claim-overlap-scheduling.md, "Undeclared scope").
 *
 * Each task runs in its own worktree on its own branch, and the merge settles
 * an overlap. A task that declares no files is not a reason to make a second
 * one wait: the claim route used to serialize scope-undeclared tasks one per
 * mission (`advisory_manifest`, shown as `scope_undeclared_mutex`), which held
 * CI repairs behind unrelated work. What still holds is what the merge cannot
 * settle (an unmergeable surface on a live holder), a declared dependency, and
 * the mission's own concurrency cap.
 *
 * The claim route is real and the rows are real: a mocked `db` would hide the
 * in-flight query that used to feed the mutex.
 */
import { beforeAll, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, confinedRunnerEnvironment, q, seedMission, seedTask, seedWorkspace } from './harness';

const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({ ...realAuthHelpers, getCurrentUser: async () => null }));

const claimRoute = await import('../../src/app/api/workers/claim/route');
const { readOrchestrationDecisionPage, summarizeOrchestrationDecisions } = await import('@buildd/core/orchestration-decision-ledger');

setDefaultTimeout(30_000);
beforeAll(() => assertDbConfigured());

const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

async function world() {
  const ws = await seedWorkspace();
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${ws.workspaceId}::uuid`);
  const missionId = await seedMission(ws.teamId, ws.workspaceId);
  const key = `bld_${crypto.randomUUID().replace(/-/g, '')}`;
  const hashed = createHash('sha256').update(key).digest('hex');
  await q(sql`
    INSERT INTO accounts (type, name, api_key, team_id, level, max_concurrent_workers)
    VALUES ('service', ${`svc-${rand()}`}, ${hashed}, ${ws.teamId}::uuid, 'worker', 10)`);
  return { ...ws, missionId, key };
}
type W = Awaited<ReturnType<typeof world>>;

/** A task of the mission with a live worker on it: the "unrelated task already running". */
async function running(w: W, pathManifest: string[] | null): Promise<string> {
  const taskId = await seedTask(w.workspaceId, { missionId: w.missionId, pathManifest, status: 'in_progress' });
  await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status)
    VALUES (${w.workspaceId}::uuid, ${taskId}::uuid, ${`wk-${rand()}`}, 'other-runner', ${`buildd/${rand()}`}, 'running')`);
  return taskId;
}

async function claim(w: W, body: Record<string, unknown>) {
  const res = await claimRoute.POST(new NextRequest('http://localhost/api/workers/claim', {
    method: 'POST',
    headers: { authorization: `Bearer ${w.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ runner: `r-${rand()}`, workspaceId: w.workspaceId, environment: confinedRunnerEnvironment(), ...body }),
  }) as never);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    workers?: Array<{ taskId: string }>;
    diagnostics?: { deferrals?: Record<string, number>; taskExclusion?: { code?: string } };
  };
}
const claimedIds = (b: { workers?: Array<{ taskId: string }> }) => (b.workers ?? []).map((x) => x.taskId).sort();

describe('undeclared scope starts by default', () => {
  test('two scope-undeclared tasks of one mission are both claimed in one poll', async () => {
    const w = await world();
    const a = await seedTask(w.workspaceId, { missionId: w.missionId, pathManifest: null });
    const b = await seedTask(w.workspaceId, { missionId: w.missionId, pathManifest: ['**'] });
    const body = await claim(w, { maxTasks: 2 });
    expect(claimedIds(body)).toEqual([a, b].sort());
  });

  test('a scope-undeclared task starts beside a running scope-undeclared sibling', async () => {
    const w = await world();
    await running(w, null);
    const candidate = await seedTask(w.workspaceId, { missionId: w.missionId, pathManifest: [] });
    const body = await claim(w, { maxTasks: 1, taskId: candidate });
    expect(claimedIds(body)).toEqual([candidate]);
    expect(body.diagnostics?.deferrals?.advisory_manifest ?? 0).toBe(0);
  });

  test('a CI repair with no manifest starts behind an unrelated running task with no manifest', async () => {
    const w = await world();
    await running(w, ['**']);
    const repair = await seedTask(w.workspaceId, { missionId: w.missionId, pathManifest: null, title: 'fix CI on the PR' });
    await q(sql`UPDATE tasks SET ci_retry_pr_number = 4242, ci_retry_head_sha = ${'a'.repeat(40)} WHERE id = ${repair}::uuid`);
    const body = await claim(w, { maxTasks: 1, taskId: repair });
    expect(claimedIds(body)).toEqual([repair]);
  });

  test('a queue that was deferred under the old serialization claims on its next poll', async () => {
    const w = await world();
    await running(w, null);
    const stale = await seedTask(w.workspaceId, { missionId: w.missionId, pathManifest: null });
    // What the retired gate left behind: a coalesced claim-loop deferral naming the running sibling.
    await q(sql`INSERT INTO gate_events (workspace_id, mission_id, task_id, gate, surface, outcome, reason, detail)
      VALUES (${w.workspaceId}::uuid, ${w.missionId}::uuid, ${stale}::uuid, 'claim_loop_deferral', 'POST /api/workers/claim', 'deferred', 'advisory_manifest',
        ${JSON.stringify({ consecutiveDeferrals: 40, firstDeferredAt: new Date(Date.now() - 3 * 3600_000).toISOString() })}::jsonb)`);
    const body = await claim(w, { maxTasks: 1 });
    expect(claimedIds(body)).toEqual([stale]);
  });
});

describe('what still holds', () => {
  test('an unmergeable surface held by a live lease still defers the candidate', async () => {
    const w = await world();
    const holder = await running(w, ['packages/core/db/schema.ts']);
    await q(sql`INSERT INTO path_claims (workspace_id, task_id, path)
      VALUES (${w.workspaceId}::uuid, ${holder}::uuid, 'packages/core/db/schema.ts')`);
    const candidate = await seedTask(w.workspaceId, { missionId: w.missionId, pathManifest: ['packages/core/db/schema.ts'] });
    const body = await claim(w, { maxTasks: 1, taskId: candidate });
    expect(claimedIds(body)).toEqual([]);
    expect(body.diagnostics?.taskExclusion?.code ?? Object.keys(body.diagnostics?.deferrals ?? {}).find((k) => (body.diagnostics?.deferrals?.[k] ?? 0) > 0)).toBe('path_overlap');
  });

  test('a declared dependency on unfinished work still holds an undeclared task', async () => {
    const w = await world();
    const dep = await running(w, null);
    const candidate = await seedTask(w.workspaceId, { missionId: w.missionId, pathManifest: null, dependsOn: [dep] });
    const body = await claim(w, { maxTasks: 1, taskId: candidate });
    expect(claimedIds(body)).toEqual([]);
  });

  test("the mission's own concurrency cap still bounds undeclared work", async () => {
    const w = await world();
    await q(sql`UPDATE missions SET max_concurrent_tasks = 1 WHERE id = ${w.missionId}::uuid`);
    await running(w, null);
    const candidate = await seedTask(w.workspaceId, { missionId: w.missionId, pathManifest: null });
    const body = await claim(w, { maxTasks: 1, taskId: candidate });
    expect(claimedIds(body)).toEqual([]);
  });
});

describe('the model ledger tells applied from suggested', () => {
  /** One orchestration_claim row as the claim's hold/start decision writes it. */
  async function decision(w: W, o: { suggested: string; effective: string; applied: boolean; status: string; reason: string | null; mode?: string; arm?: string }) {
    await q(sql`INSERT INTO orchestration_decisions (team_id, workspace_id, mission_id, capability, decision_id, decision_version, fingerprint,
        question, mode, candidate_policy_version, candidate_digest, candidate_count, rule_verdict, suggested, confidence, effective,
        applied, status, reason, latency_ms, experiment_arm, propensity, applying_fraction)
      VALUES (${w.teamId}::uuid, ${w.workspaceId}::uuid, ${w.missionId}::uuid, 'orchestration_claim', 'buildd.orchestration_claim_hold', 1, 'fp',
        'hold', ${o.mode ?? 'gated'}, 'ch1.open_pr_overlap', ${`d-${rand()}`}, 1, 'HOLD', ${o.suggested}, 0.5, ${o.effective},
        ${o.applied}, ${o.status}, ${o.reason}, 10, ${o.arm ?? 'apply'}, 1, 1)`);
  }

  test('a START from an unmeasured model counts as suggested with the rule in effect; only an applied row counts as applied', async () => {
    const w = await world();
    await decision(w, { suggested: 'START', effective: 'HOLD', applied: false, status: 'suggested', reason: 'non_jev' });
    await decision(w, { suggested: 'START', effective: 'HOLD', applied: false, status: 'suggested', reason: 'below_threshold' });
    await decision(w, { suggested: 'START', effective: 'START', applied: true, status: 'applied', reason: null, mode: 'live', arm: 'human' });
    const page = await readOrchestrationDecisionPage({ workspaceId: w.workspaceId, capability: 'orchestration_claim' });
    const summary = summarizeOrchestrationDecisions(page.rows);
    expect(summary.byStatus).toEqual({ suggested: 2, applied: 1 });
    expect(summary.byVerdict).toEqual({ START: 3 });
    expect(summary.byAppliedAnswer).toEqual({ none: 2, START: 1 });
    expect(summary.byReason).toMatchObject({ non_jev: 1, below_threshold: 1 });
  });
});
