/**
 * The Scout runner-host store's SQL against real Postgres
 * (apps/web/src/lib/quality-scout-runner-host-store.ts). A mocked `db` makes
 * every predicate here unobservable, and these are the ones that decide who
 * may act: the claim is a compare-and-set with exactly one winner, a run is
 * visible only inside its workspace's team whatever workspace ids the caller
 * offers, a result is written only while the writer's lease is live, and the
 * finalize hand-off has one winner.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { qualityScoutProbes, qualityScoutRuns } from '@buildd/core/db/schema';
import { saveScoutProbes, saveScoutRun } from '@buildd/core/quality-scout/ledger';
import type { ScoutProbeRecord, ScoutRun } from '@buildd/core/quality-scout/types';
import { reportScoutProbeResults, scoutLeaseHolder } from '@/lib/quality-scout-runner-host';
import { dbScoutRunnerHostStore as store } from '@/lib/quality-scout-runner-host-store';
import { parkedRun, probeRecord, runnerResult } from '@/lib/quality-scout-runner-host.fixtures';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const MIN = 60_000;
let seq = 0;

beforeAll(() => {
  assertDbConfigured();
});

async function seedRepo(workspaceId: string): Promise<string> {
  const n = `${Date.now()}${seq++}`;
  const fullName = `acme/tool-${n}`;
  const [inst] = await q<{ id: string }>(sql`
    INSERT INTO github_installations (installation_id, account_type, account_login, account_id)
    VALUES (${Number(n.slice(-12))}, 'Organization', 'acme', 1) RETURNING id`);
  const [repo] = await q<{ id: string }>(sql`
    INSERT INTO github_repos (installation_id, repo_id, full_name, name, owner)
    VALUES (${inst.id}::uuid, ${Number(n.slice(-12))}, ${fullName}, ${`tool-${n}`}, 'acme') RETURNING id`);
  await db.execute(sql`UPDATE workspaces SET github_repo_id = ${repo.id}::uuid WHERE id = ${workspaceId}::uuid`);
  return fullName;
}

/** A run parked now, with the given probes saved. */
async function park(workspaceId: string, probes: ScoutProbeRecord[] = [probeRecord('c1')], over: Partial<ScoutRun> = {}): Promise<ScoutRun> {
  const run = parkedRun(workspaceId, over, new Date());
  await saveScoutRun(run);
  await saveScoutProbes(run, probes);
  return run;
}

const row = async (id: string) => (await db.select().from(qualityScoutRuns).where(eq(qualityScoutRuns.id, id)))[0];
const lease = (minutes: number) => new Date(Date.now() + minutes * MIN);

describe('listClaimable / claim: team scoping', () => {
  test("another team's parked run is never listed or claimed, even when its workspace id is offered", async () => {
    const a = await seedWorkspace();
    const b = await seedWorkspace();
    await seedRepo(a.workspaceId);
    await seedRepo(b.workspaceId);
    const mine = await park(a.workspaceId);
    const theirs = await park(b.workspaceId);
    const listed = await store.listClaimable({ teamId: a.teamId, workspaceIds: [a.workspaceId, b.workspaceId], now: new Date(), limit: 25 });
    expect(listed.map((c) => c.run.id)).toEqual([mine.id]);
    expect(listed[0].repo).toMatch(/^acme\/tool-/);
    expect(listed[0].probes.map((p) => p.candidateId)).toEqual(['c1']);
    expect(await store.claim({ runId: theirs.id, teamId: a.teamId, holder: 'acct:x', now: new Date(), leaseExpiresAt: lease(25) })).toBeNull();
    expect((await row(theirs.id)).hostLeaseHolder).toBeNull();
    expect(await store.loadForTeam(theirs.id, a.teamId)).toBeNull();
  });

  test('only runner-assigned, selected probes without a result are handed out', async () => {
    const a = await seedWorkspace();
    const run = await park(a.workspaceId, [
      probeRecord('c1'),
      probeRecord('srv', { host: 'server' }),
      probeRecord('skip', { selection: { status: 'skipped', reason: 'budget', reasonCode: null } }),
    ]);
    const [c] = await store.listClaimable({ teamId: a.teamId, workspaceIds: [a.workspaceId], now: new Date(), limit: 25 });
    expect(c.run.id).toBe(run.id);
    expect(c.probes.map((p) => p.candidateId)).toEqual(['c1']);
  });

  test('a run past its deadline is not claimable', async () => {
    const a = await seedWorkspace();
    const run = await park(a.workspaceId, undefined, {});
    await db.execute(sql`UPDATE quality_scout_runs SET host_deadline = now() - interval '1 minute' WHERE id = ${run.id}::uuid`);
    expect(await store.listClaimable({ teamId: a.teamId, workspaceIds: [a.workspaceId], now: new Date(), limit: 25 })).toEqual([]);
    expect(await store.claim({ runId: run.id, teamId: a.teamId, holder: 'acct:x', now: new Date(), leaseExpiresAt: lease(25) })).toBeNull();
  });
});

describe('claim: the lease compare-and-set', () => {
  test('concurrent claims of one run: exactly one wins', async () => {
    const a = await seedWorkspace();
    const run = await park(a.workspaceId);
    const results = await Promise.all([1, 2, 3, 4].map((i) =>
      store.claim({ runId: run.id, teamId: a.teamId, holder: `acct:${i}`, now: new Date(), leaseExpiresAt: lease(25) })));
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect((await row(run.id)).hostLeaseHolder).toBe(winners[0]!.parking!.lease!.holder);
  });

  test('a lapsed lease can be taken over once, counting the lapse; a second lapse is the sweep\'s', async () => {
    const a = await seedWorkspace();
    const run = await park(a.workspaceId);
    const past = new Date(Date.now() - MIN);
    expect(await store.claim({ runId: run.id, teamId: a.teamId, holder: 'acct:1', now: new Date(), leaseExpiresAt: past })).not.toBeNull();
    const second = await store.claim({ runId: run.id, teamId: a.teamId, holder: 'acct:2', now: new Date(), leaseExpiresAt: past });
    expect(second?.parking?.leaseLapses).toBe(1);
    expect(await store.claim({ runId: run.id, teamId: a.teamId, holder: 'acct:3', now: new Date(), leaseExpiresAt: lease(25) })).toBeNull();
    expect((await row(run.id)).hostLeaseHolder).toBe('acct:2');
  });
});

describe('recordResult: only under a live lease', () => {
  test('writes a runner probe once, for the holder only, and keeps its reproducibility on the plan', async () => {
    const a = await seedWorkspace();
    const run = await park(a.workspaceId, [probeRecord('c1'), probeRecord('srv', { host: 'server' })]);
    await store.claim({ runId: run.id, teamId: a.teamId, holder: 'acct:1', now: new Date(), leaseExpiresAt: lease(25) });
    const result = await runnerResult(run, probeRecord('c1'));
    const base = { runId: run.id, now: new Date(), result, reproducibility: 'deterministic' as const };
    expect(await store.recordResult({ ...base, holder: 'acct:2', candidateId: 'c1' })).toBe(false);
    expect(await store.recordResult({ ...base, holder: 'acct:1', candidateId: 'srv' })).toBe(false);
    expect(await store.remainingRunnerProbes(run.id)).toBe(1);
    expect(await store.recordResult({ ...base, holder: 'acct:1', candidateId: 'c1' })).toBe(true);
    expect(await store.recordResult({ ...base, holder: 'acct:1', candidateId: 'c1' })).toBe(false);
    expect(await store.remainingRunnerProbes(run.id)).toBe(0);
    const [p] = await db.select().from(qualityScoutProbes).where(sql`${qualityScoutProbes.runId} = ${run.id}::uuid AND ${qualityScoutProbes.candidateId} = 'c1'`);
    expect(p.verdict).toBe(result.verdict);
    expect(p.signature).toBe(result.signature);
    expect((await row(run.id)).hostState!.plan.reproducibility).toEqual({ c1: 'deterministic' });
  });

  test('an expired lease writes nothing', async () => {
    const a = await seedWorkspace();
    const run = await park(a.workspaceId);
    await store.claim({ runId: run.id, teamId: a.teamId, holder: 'acct:1', now: new Date(), leaseExpiresAt: new Date(Date.now() - 1000) });
    const result = await runnerResult(run, probeRecord('c1'));
    expect(await store.recordResult({ runId: run.id, holder: 'acct:1', now: new Date(), candidateId: 'c1', result, reproducibility: 'unknown' })).toBe(false);
  });
});

describe('take / release', () => {
  test('concurrent finalize hand-offs: exactly one takes the run, and only the holder can', async () => {
    const a = await seedWorkspace();
    const run = await park(a.workspaceId);
    await store.claim({ runId: run.id, teamId: a.teamId, holder: 'acct:1', now: new Date(), leaseExpiresAt: lease(25) });
    expect(await store.take(run.id, 'acct:2')).toBe(false);
    const taken = await Promise.all([1, 2, 3].map(() => store.take(run.id, 'acct:1')));
    expect(taken.filter(Boolean)).toHaveLength(1);
    expect((await row(run.id)).status).toBe('running');
  });

  test('release clears the lease for its holder only, records why, and is not a lapse', async () => {
    const a = await seedWorkspace();
    const run = await park(a.workspaceId);
    await store.claim({ runId: run.id, teamId: a.teamId, holder: 'acct:1', now: new Date(), leaseExpiresAt: lease(25) });
    expect(await store.release({ runId: run.id, holder: 'acct:2', now: new Date(), reason: 'x' })).toBe(false);
    expect(await store.release({ runId: run.id, holder: 'acct:1', now: new Date(), reason: 'cannot fetch sha' })).toBe(true);
    const r = await row(run.id);
    expect(r).toMatchObject({ status: 'awaiting_host', hostLeaseHolder: null, hostLeaseExpiresAt: null, hostLeaseLapses: 0 });
    expect(r.hostState!.plan.warnings).toEqual(['runner released: cannot fetch sha']);
    expect(await store.claim({ runId: run.id, teamId: a.teamId, holder: 'acct:2', now: new Date(), leaseExpiresAt: lease(25) })).not.toBeNull();
  });
});

describe('sweepExpired: narrowed to the caller\'s workspaces', () => {
  test("finalizes this workspace's expired run and leaves another workspace's alone", async () => {
    const a = await seedWorkspace();
    const b = await seedWorkspace();
    const mine = await park(a.workspaceId);
    const theirs = await park(b.workspaceId);
    await db.execute(sql`UPDATE quality_scout_runs SET host_deadline = now() - interval '1 minute' WHERE id IN (${mine.id}::uuid, ${theirs.id}::uuid)`);
    const finalized = await store.sweepExpired([a.workspaceId]);
    expect(finalized).toContain(mine.id);
    expect(finalized).not.toContain(theirs.id);
    expect((await row(mine.id)).status).toBe('completed');
    expect((await row(theirs.id)).status).toBe('awaiting_host');
  });
});

describe('the last result finalizes on the server', () => {
  test('through the real store: the run completes with the runner verdict, never with a missing one', async () => {
    const a = await seedWorkspace();
    const run = await park(a.workspaceId, [probeRecord('c1'), probeRecord('c2')]);
    const leaseId = crypto.randomUUID();
    await store.claim({ runId: run.id, teamId: a.teamId, holder: scoutLeaseHolder('acct-1', leaseId), now: new Date(), leaseExpiresAt: lease(25) });
    const caller = { accountId: 'acct-1', teamId: a.teamId, accessibleWorkspaceIds: new Set([a.workspaceId]) };
    const r1 = await runnerResult(run, probeRecord('c1'));
    const r2 = await runnerResult(run, probeRecord('c2'), { exitCode: 3 });
    const first = await reportScoutProbeResults({ caller, runId: run.id, leaseId, now: new Date(), results: [{ candidateId: 'c1', result: r1 }] }, store);
    expect(first.body).toEqual({ accepted: ['c1'], remaining: 1, finalized: false });
    expect((await row(run.id)).status).toBe('awaiting_host');
    const last = await reportScoutProbeResults({ caller, runId: run.id, leaseId, now: new Date(), results: [{ candidateId: 'c2', result: r2, reproducibility: 'deterministic' }] }, store);
    expect(last.body).toEqual({ accepted: ['c2'], remaining: 0, finalized: true, runStatus: 'completed' });
    const done = await row(run.id);
    expect(done.status).toBe('completed');
    expect(done.verdicts).toMatchObject({ total: 2, pass: 1, fail: 1 });
    expect(done.metrics?.hosts?.runnerProbes).toBe(2);
  });
});
