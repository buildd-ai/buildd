/**
 * The landing lane (knowledge-base: buildd/design/landing-lane.md): one
 * behind-refresh in flight per repo + base.
 *
 * Two approved PRs on one base, both behind. A changes `package.json`, so once
 * A merges, B's gap is not one the disjoint-delta rule tolerates. Without the
 * lane both refresh at once, A lands, and B refreshes a second time onto A's
 * merge. With the lane, B waits while A refreshes and lands, then refreshes
 * once onto the base A produced.
 *
 * The real kernel on real Postgres against the stateful fake GitHub, through
 * the landing door (`landPr`) the sweep and the webhooks call.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { q } from './harness';
import { world, type OpenedPr, type World } from './workflow-scenarios-world';

const { landPr } = await import('../../src/lib/pr-landing');
const { drainDelivery } = await import('../../src/lib/workflow/seam');
const { applyCommand } = await import('../../src/lib/workflow/kernel');
const { LANE_MAX_TENURE_MS } = await import('../../src/lib/workflow/landing-lane');

let w: World;
afterEach(() => w?.dispose());

const sweep = (pr: OpenedPr) => landPr({
  workspaceId: w.workspaceId, installationId: w.installationId, repoFullName: w.repo, prNumber: pr.prNumber, eventHeadSha: null,
  door: 'sweep', actor: { kind: 'system' }, mode: 'enforce', policy: { tier: 'auto-threshold' }, owner: { taskId: pr.ownerTaskId, workerId: pr.workerId },
});

const updateBranchCalls = (pr: OpenedPr) =>
  w.gh.calls.filter((c) => c.method === 'PUT' && c.path === `/repos/${w.repo}/pulls/${pr.prNumber}/update-branch`);

const refreshEffects = async (pr: OpenedPr) =>
  (await w.effects(pr)).filter((e) => e.kind === 'refresh_branch');

/** CI goes green on the PR's live head (unless it already merged). */
async function green(pr: OpenedPr): Promise<void> {
  const live = w.gh.pr(w.repo, pr.prNumber);
  if (!live.merged) w.gh.greenCi(w.repo, live.headSha, ['build', 'test']);
  await w.deliver();
}

/** A (touches package.json) and B (touches its own file), both approved, then dev moves under both. */
async function twoBehind(): Promise<{ a: OpenedPr; b: OpenedPr }> {
  const a = await w.openPr({ branch: 'feat/a-deps', files: { 'package.json': '{ "name": "x", "version": "2" }\n' } });
  const b = await w.openPr({ branch: 'feat/b-code', files: { 'src/b.ts': 'export const b = 2;\n' } });
  await w.approve(a);
  await w.approve(b);
  w.gh.advanceBase(w.repo, 'dev', { 'src/other.ts': 'export const o = 1;\n' });
  await w.deliver();
  expect((await w.delivery(a)).state).toBe('APPROVED');
  expect((await w.delivery(b)).state).toBe('APPROVED');
  return { a, b };
}

/** Both PRs through the landing door until each merged or `rounds` passes ran. */
async function landBoth(a: OpenedPr, b: OpenedPr, rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    for (const pr of [a, b]) {
      if (w.gh.pr(w.repo, pr.prNumber).merged) continue;
      await sweep(pr);
      await w.deliver();
      await green(pr);
    }
  }
}

describe('landing lane: one behind-refresh in flight per base', () => {
  test('off (the default): both refresh at once, and B refreshes again onto A\'s merge', async () => {
    w = await world();
    const { a, b } = await twoBehind();
    await landBoth(a, b);
    expect(w.gh.pr(w.repo, a.prNumber).merged).toBe(true);
    expect(w.gh.pr(w.repo, b.prNumber).merged).toBe(true);
    expect(updateBranchCalls(a)).toHaveLength(1);
    expect(updateBranchCalls(b)).toHaveLength(2);
    expect((await q(sql`SELECT 1 FROM landing_lanes WHERE repo_full_name = ${w.repo}`))).toHaveLength(0);
  });

  test('enforce: B parks while A holds the lane, wakes when A merges, and refreshes once', async () => {
    w = await world({ gitConfig: { landingLane: 'enforce' } });
    const { a, b } = await twoBehind();

    // A takes the lane and refreshes; B's refresh parks behind it.
    await sweep(a);
    await w.deliver();
    await sweep(b);
    await w.deliver();
    expect(updateBranchCalls(a)).toHaveLength(1);
    expect(updateBranchCalls(b)).toHaveLength(0);
    const parked = (await refreshEffects(b))[0];
    expect(parked).toMatchObject({ status: 'pending', outcome: `parked:lane_busy:#${a.prNumber}` });
    // A wait is not a failure: the parked row has spent no attempt.
    const [row] = await q<{ attempt_count: number; last_error: string | null }>(
      sql`SELECT attempt_count, last_error FROM workflow_effects WHERE dedupe_key = ${parked.dedupe_key}`);
    expect(row).toMatchObject({ attempt_count: 0, last_error: null });
    expect((await w.delivery(b))).toMatchObject({ state: 'REPAIRING', stateReason: 'behind' });

    // B draining again while A still holds the lane parks again, still spending nothing.
    await drainDelivery(b.deliveryId);
    expect(updateBranchCalls(b)).toHaveLength(0);

    // A goes green and lands; its merge frees the lane and wakes B, which refreshes onto A's merge.
    await green(a);
    await sweep(a);
    await w.deliver();
    expect(w.gh.pr(w.repo, a.prNumber).merged).toBe(true);
    expect(updateBranchCalls(b)).toHaveLength(1);
    expect(w.gh.files(w.repo, `feat/b-code`)).toMatchObject({ 'package.json': '{ "name": "x", "version": "2" }\n' });

    // B goes green and lands with no second refresh.
    await green(b);
    await sweep(b);
    await w.deliver();
    expect(w.gh.pr(w.repo, b.prNumber).merged).toBe(true);
    expect(updateBranchCalls(b)).toHaveLength(1);
    expect((await w.delivery(b)).state).toBe('MERGED');
    // Nothing holds the lane once both landed.
    expect(await q(sql`SELECT 1 FROM landing_lanes WHERE repo_full_name = ${w.repo}`)).toHaveLength(0);
    expect(w.gh.unsupported).toEqual([]);
  });

  test('enforce: the holder\'s CI goes red → the lane frees and the waiter refreshes', async () => {
    w = await world({ gitConfig: { landingLane: 'enforce' } });
    const { a, b } = await twoBehind();
    await sweep(a);
    await w.deliver();
    await sweep(b);
    await w.deliver();
    expect(updateBranchCalls(b)).toHaveLength(0);

    w.gh.setCheck(w.repo, w.gh.pr(w.repo, a.prNumber).headSha, 'build', { conclusion: 'failure' });
    await w.deliver();
    expect((await w.delivery(a)).state).not.toBe('APPROVED');
    expect(updateBranchCalls(b)).toHaveLength(1);
  });

  // eccb6687: the lane is for landing order. A holder that will not land soon does not hold
  // the behind PRs' refreshes: B refreshes and lands while A is still unmerged.
  test('enforce: the holder reads red at its head while still in the window → B refreshes and lands without waiting', async () => {
    w = await world({ gitConfig: { landingLane: 'enforce' } });
    const { a, b } = await twoBehind();
    await sweep(a);
    await w.deliver();
    await sweep(b);
    await w.deliver();
    expect(updateBranchCalls(b)).toHaveLength(0);

    // The red reading T10 leaves when it does not act (a re-run, a fix it will not start): A stays in the window.
    const head = (await w.delivery(a)).currentHeadSha!;
    const r = await applyCommand({ type: 'CiObserved', actor: 'webhook:ci_reading', headSha: head, verdict: 'red', liveChecks: { complete: true, failing: ['test'] } }, { ref: { deliveryId: a.deliveryId } });
    expect(r.result).toBe('applied');
    expect(['APPROVED', 'REPAIRING']).toContain((await w.delivery(a)).state);
    // A's drain settles its lane and wakes B.
    await drainDelivery(a.deliveryId);
    expect(updateBranchCalls(b)).toHaveLength(1);

    await green(b);
    await sweep(b);
    await w.deliver();
    expect(w.gh.pr(w.repo, b.prNumber).merged).toBe(true);
    expect(w.gh.pr(w.repo, a.prNumber).merged).toBe(false);
    expect(w.gh.unsupported).toEqual([]);
  });

  test('enforce: a holder past its tenure yields to the waiter even with its lease running', async () => {
    w = await world({ gitConfig: { landingLane: 'enforce' } });
    const { a, b } = await twoBehind();
    await sweep(a);
    await w.deliver();
    await sweep(b);
    await w.deliver();
    const due = sql`UPDATE workflow_effects SET not_before = now() WHERE delivery_id = ${b.deliveryId}::uuid AND kind = 'refresh_branch'`;
    await q(due);
    await drainDelivery(b.deliveryId);
    expect(updateBranchCalls(b)).toHaveLength(0);

    // A took the lane longer ago than the cap; its lease (renewed or not) still runs.
    await q(sql`UPDATE landing_lanes SET granted_at = now() - make_interval(secs => ${LANE_MAX_TENURE_MS / 1000 + 60}::int)
      WHERE repo_full_name = ${w.repo}`);
    await q(due);
    await drainDelivery(b.deliveryId);
    expect(updateBranchCalls(b)).toHaveLength(1);
    const [lane] = await q<{ delivery_id: string }>(sql`SELECT delivery_id FROM landing_lanes WHERE repo_full_name = ${w.repo}`);
    expect(lane.delivery_id).toBe(b.deliveryId);

    await green(b);
    await sweep(b);
    await w.deliver();
    expect(w.gh.pr(w.repo, b.prNumber).merged).toBe(true);
    expect(w.gh.pr(w.repo, a.prNumber).merged).toBe(false);
  });

  // eccb6687 (sweep 202fe852): the lane passed from one not-landable head to another. A free lane
  // goes to the next waiter that can land; one with a CI fix in flight refreshes beside it.
  test('enforce: the holder goes red and the oldest waiter has a CI fix in flight → the lane skips it to the next, and the fixing one refreshes beside the lane', async () => {
    w = await world({ gitConfig: { landingLane: 'enforce' } });
    const a = await w.openPr({ branch: 'feat/a-deps', files: { 'package.json': '{ "name": "x", "version": "2" }\n' } });
    const b = await w.openPr({ branch: 'feat/b-fixing', files: { 'src/b.ts': 'export const b = 2;\n' } });
    const c = await w.openPr({ branch: 'feat/c-code', files: { 'src/c.ts': 'export const c = 3;\n' } });
    for (const pr of [a, b, c]) await w.approve(pr);
    w.gh.advanceBase(w.repo, 'dev', { 'src/other.ts': 'export const o = 1;\n' });
    await w.deliver();
    for (const pr of [a, b, c]) {
      await sweep(pr);
      await w.deliver();
    }
    expect(updateBranchCalls(a)).toHaveLength(1);
    expect(updateBranchCalls(b)).toHaveLength(0);
    expect(updateBranchCalls(c)).toHaveLength(0);

    // B's CI fix is in flight (T10 rejects its red reading as fix_in_flight, so only the attempt shows it).
    await q(sql`INSERT INTO workflow_attempts (delivery_id, family, attempt_no, mode, status, max_attempts)
      VALUES (${b.deliveryId}::uuid, 'ci', 1, 'agent', 'running', 3)`);
    // A goes red at its head and its drain settles the lane: the wake passes over B and makes C due.
    const head = (await w.delivery(a)).currentHeadSha!;
    await applyCommand({ type: 'CiObserved', actor: 'webhook:ci_reading', headSha: head, verdict: 'red', liveChecks: { complete: true, failing: ['test'] } }, { ref: { deliveryId: a.deliveryId } });
    await drainDelivery(a.deliveryId);
    await drainDelivery(c.deliveryId);
    expect(updateBranchCalls(c)).toHaveLength(1);
    expect(updateBranchCalls(b)).toHaveLength(0);
    const holder = async () => (await q<{ delivery_id: string }>(sql`SELECT delivery_id FROM landing_lanes WHERE repo_full_name = ${w.repo}`))[0]?.delivery_id;
    expect(await holder()).toBe(c.deliveryId);

    // B's backstop comes due: it refreshes beside the lane, neither waiting on C nor taking it.
    await q(sql`UPDATE workflow_effects SET not_before = now() WHERE delivery_id = ${b.deliveryId}::uuid AND kind = 'refresh_branch'`);
    await drainDelivery(b.deliveryId);
    expect(updateBranchCalls(b)).toHaveLength(1);
    expect(await holder()).toBe(c.deliveryId);

    await green(c);
    await sweep(c);
    await w.deliver();
    expect(w.gh.pr(w.repo, c.prNumber).merged).toBe(true);
    expect(w.gh.pr(w.repo, a.prNumber).merged).toBe(false);
    expect(w.gh.unsupported).toEqual([]);
  });

  test('enforce: a lease that ran out frees the lane for the next drain, with no release', async () => {
    w = await world({ gitConfig: { landingLane: 'enforce' } });
    const { a, b } = await twoBehind();
    await sweep(a);
    await w.deliver();
    await sweep(b);
    await w.deliver();
    expect(updateBranchCalls(b)).toHaveLength(0);

    await q(sql`UPDATE landing_lanes SET lease_until = now() - interval '1 second' WHERE repo_full_name = ${w.repo}`);
    await q(sql`UPDATE workflow_effects SET not_before = now() WHERE delivery_id = ${b.deliveryId}::uuid AND kind = 'refresh_branch'`);
    await drainDelivery(b.deliveryId);
    expect(updateBranchCalls(b)).toHaveLength(1);
    const [lane] = await q<{ delivery_id: string }>(sql`SELECT delivery_id FROM landing_lanes WHERE repo_full_name = ${w.repo}`);
    expect(lane.delivery_id).toBe(b.deliveryId);
  });

  test('shadow: nothing waits; the refresh that would have records whom it would have waited for', async () => {
    w = await world({ gitConfig: { landingLane: 'shadow' } });
    const { a, b } = await twoBehind();
    await sweep(a);
    await w.deliver();
    await sweep(b);
    await w.deliver();
    expect(updateBranchCalls(a)).toHaveLength(1);
    expect(updateBranchCalls(b)).toHaveLength(1);
    expect((await refreshEffects(b))[0]).toMatchObject({ status: 'done', outcome: `ok:updated(lane:would_wait:#${a.prNumber})` });
  });

  test('every behind refresh records the verdict it went ahead on', async () => {
    w = await world();
    const { a } = await twoBehind();
    await sweep(a);
    await w.deliver();
    const [t] = await q<{ evidence: Record<string, any> }>(sql`SELECT evidence FROM workflow_transitions
      WHERE delivery_id = ${a.deliveryId}::uuid AND command = 'ConflictObserved' AND to_state = 'REPAIRING' ORDER BY to_version LIMIT 1`);
    expect(t.evidence).toMatchObject({ repairKind: 'behind', mode: 'mechanical' });
    expect(t.evidence.freshness).toMatchObject({ tolerated: false, cause: expect.any(String) });
  });
});
