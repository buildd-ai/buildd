/**
 * The mission refresh as an outbox effect of the writable epoch, on real
 * Postgres (docs/specs/workflow-kernel-library.md §6; report 7fff4f77
 * follow-up 17): the row is owed only by the open epoch, one per trigger and
 * window, never by a merged epoch; it is drained under a lease, settled to
 * the attempt that ran, retried on a failure, re-claimed after its lease runs
 * out, and skipped without running when its epoch merged after it was owed.
 * The delivery drain never claims it, and the table refuses a row with no
 * owner or two.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { q, seedMission, seedWorkspace } from './harness';

const epochs = await import('../../src/lib/workflow/delivery-epochs');
const fx = await import('../../src/lib/workflow/epoch-effects');
const { claimDueEffectsSql } = await import('../../src/lib/workflow/effects');

const REPO = 'acme/app';
const ROOT = 'mission/kernel';
const AT = new Date('2026-10-14T12:00:00.000Z');
type Deps = NonNullable<Parameters<typeof epochs.applyMissionEpochCommand>[2]>;

let missionId: string;
let work = { unfinishedTasks: 1, openTaskPrs: 0 };
const deps = (): Deps => ({ workOf: async () => work, legacyPrOf: async () => null });

async function rows() {
  return q<{ id: string; status: string; outcome: string | null; attempt_count: number; epoch_id: string | null; delivery_id: string | null; payload: Record<string, unknown> }>(
    sql`SELECT e.id, e.status, e.outcome, e.attempt_count, e.epoch_id, e.delivery_id, e.payload FROM workflow_effects e
        JOIN workflow_mission_epochs ep ON ep.id = e.epoch_id WHERE ep.mission_id = ${missionId}::uuid ORDER BY e.created_at`,
  );
}

/** Epoch 1 (adopted, open on ROOT) with its mission PR #10 bound. */
async function adopted() {
  await epochs.applyMissionEpochCommand(missionId, { type: 'Adopt', actor: 'test', at: AT.toISOString() }, deps());
  await epochs.applyMissionEpochCommand(missionId, { type: 'PrBound', actor: 'test', at: AT.toISOString(), prNumber: 10, repoFullName: REPO, ownerTaskId: null, headRef: ROOT }, deps());
}
async function mergeEpoch1() {
  await epochs.applyMissionEpochCommand(missionId, {
    type: 'Merged', actor: 'test', at: AT.toISOString(), prNumber: 10, repoFullName: REPO, headRef: ROOT,
    mergeCommitSha: 'm1', mergedHeadSha: 'h1', mergedAt: AT.toISOString(),
  }, deps());
}

/** A handler that records what it was asked to refresh. */
function recording(answer: () => Promise<{ outcome: string; park?: { delayMs: number } }> = async () => ({ outcome: 'merged' })) {
  const ran: Array<{ missionId: string; trigger: unknown; branch: unknown }> = [];
  const handlers: fx.EpochEffectHandlers = {
    async refresh_mission_branch(e) {
      ran.push({ missionId: e.epoch!.missionId, trigger: e.payload.trigger, branch: e.payload.branch });
      return answer();
    },
  };
  return { ran, handlers };
}

beforeEach(async () => {
  work = { unfinishedTasks: 1, openTaskPrs: 0 };
  const ws = await seedWorkspace();
  missionId = await seedMission(ws.teamId, ws.workspaceId);
  await q(sql`UPDATE missions SET working_branch = ${ROOT}, integration_branch_enabled = true WHERE id = ${missionId}::uuid`);
});

describe('what the epoch owes', () => {
  test('a mission with no epoch rows owes nothing here: the caller refreshes the legacy way', async () => {
    expect(await fx.oweMissionRefresh(missionId, { trigger: 'start', now: AT })).toEqual({ owed: 'legacy' });
    expect(await rows()).toEqual([]);
  });

  test('the writable epoch owes one row per trigger and window, owned by the epoch alone', async () => {
    await adopted();
    const a = await fx.oweMissionRefresh(missionId, { trigger: 'start', now: AT });
    const b = await fx.oweMissionRefresh(missionId, { trigger: 'start', now: new Date(AT.getTime() + 1_000) });
    expect(a).toMatchObject({ owed: 'effect', fresh: true });
    expect(b).toMatchObject({ owed: 'effect', fresh: false, effectId: (a as { effectId: string }).effectId });
    await fx.oweMissionRefresh(missionId, { trigger: 'backstop', now: AT });
    const r = await rows();
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.delivery_id === null && x.epoch_id !== null && x.status === 'pending')).toBe(true);
    expect(r.map((x) => x.payload)).toEqual([{ branch: ROOT, trigger: 'start' }, { branch: ROOT, trigger: 'backstop' }]);
  });

  test('a merged epoch owes none (no successor: nothing left to do)', async () => {
    await adopted();
    work = { unfinishedTasks: 0, openTaskPrs: 0 };
    await mergeEpoch1();
    expect(await fx.oweMissionRefresh(missionId, { trigger: 'start', now: AT })).toEqual({ owed: 'none', reason: 'epoch_merged' });
    expect(await fx.oweMissionRefresh(missionId, { trigger: 'backstop', now: AT })).toEqual({ owed: 'none', reason: 'epoch_merged' });
    expect(await rows()).toEqual([]);
  });

  test('a successor owes nothing until its branch is cut, then owes a refresh of its own branch', async () => {
    await adopted();
    await mergeEpoch1();
    expect(await fx.oweMissionRefresh(missionId, { trigger: 'start', now: AT })).toEqual({ owed: 'none', reason: 'branch_not_cut' });
    const e2 = (await epochs.loadMissionEpochView(missionId, deps()))!.view.epochs[1]!;
    await epochs.applyMissionEpochCommand(missionId, { type: 'BranchReady', actor: 'test', at: AT.toISOString(), epochId: e2.id }, deps());
    expect(await fx.oweMissionRefresh(missionId, { trigger: 'start', now: AT })).toMatchObject({ owed: 'effect', epochId: e2.id });
    expect((await rows()).map((x) => x.payload.branch)).toEqual([e2.branch]);
  });

  test('the table refuses a row with no owner, or with an epoch and a delivery both', async () => {
    await adopted();
    const epochId = (await epochs.loadMissionEpochView(missionId, deps()))!.view.epochs[0]!.id;
    await expect(q(sql`INSERT INTO workflow_effects (kind, dedupe_key) VALUES ('refresh_mission_branch', ${`orphan-${missionId}`})`)).rejects.toThrow();
    await expect(q(sql`INSERT INTO workflow_effects (epoch_id, delivery_id, kind, dedupe_key)
      VALUES (${epochId}::uuid, gen_random_uuid(), 'refresh_mission_branch', ${`both-${missionId}`})`)).rejects.toThrow();
  });
});

describe('draining it', () => {
  test('the asking request drains its own row: the handler runs once and the row is done', async () => {
    await adopted();
    const owed = await fx.oweMissionRefresh(missionId, { trigger: 'start', now: AT });
    const h = recording();
    const s = await fx.drainEpochEffects({ handlers: h.handlers, effectIds: [(owed as { effectId: string }).effectId] });
    expect(s).toMatchObject({ claimed: 1, done: 1 });
    expect(h.ran).toEqual([{ missionId, trigger: 'start', branch: ROOT }]);
    expect((await rows()).map((x) => [x.status, x.outcome])).toEqual([['done', 'merged']]);
    // Done is done: draining again runs nothing.
    expect((await fx.drainEpochEffects({ handlers: h.handlers, effectIds: [(owed as { effectId: string }).effectId] })).claimed).toBe(0);
  });

  test('a row owed before its epoch merged is skipped when claimed, without running', async () => {
    await adopted();
    await fx.oweMissionRefresh(missionId, { trigger: 'backstop', now: AT });
    work = { unfinishedTasks: 0, openTaskPrs: 0 };
    await mergeEpoch1();
    const h = recording();
    const s = await fx.drainEpochEffects({ handlers: h.handlers });
    expect(s.skipped).toBeGreaterThanOrEqual(1);
    expect(h.ran.filter((x) => x.missionId === missionId)).toEqual([]);
    expect((await rows()).map((x) => [x.status, x.outcome])).toEqual([['done', 'skipped:superseded']]);
  });

  test('a failed attempt backs off and stays owed; a wait on another lease spends no attempt', async () => {
    await adopted();
    const owed = (await fx.oweMissionRefresh(missionId, { trigger: 'start', now: AT })) as { effectId: string };
    const failing = recording(async () => { throw new Error('could not read dev'); });
    expect(await fx.drainEpochEffects({ handlers: failing.handlers, effectIds: [owed.effectId] })).toMatchObject({ failed: 1 });
    let [r] = await rows();
    expect([r!.status, r!.attempt_count]).toEqual(['pending', 1]);
    // Due now: the backoff is the floor's wait, not this test's.
    await q(sql`UPDATE workflow_effects SET not_before = now() WHERE id = ${owed.effectId}::uuid`);
    const parked = recording(async () => ({ outcome: 'parked:in_flight', park: { delayMs: 60_000 } }));
    expect(await fx.drainEpochEffects({ handlers: parked.handlers, effectIds: [owed.effectId] })).toMatchObject({ skipped: 1 });
    [r] = await rows();
    expect([r!.status, r!.attempt_count, r!.outcome]).toEqual(['pending', 1, 'parked:in_flight']);
  });

  test('a request torn down mid-refresh leaves the row leased; once the lease runs out the floor drains it', async () => {
    await adopted();
    const owed = (await fx.oweMissionRefresh(missionId, { trigger: 'start', now: AT })) as { effectId: string };
    // The request claimed it and died: delivering, lease already expired.
    await q(sql`UPDATE workflow_effects SET status = 'delivering', attempt_count = 1, lease_until = now() - interval '1 second' WHERE id = ${owed.effectId}::uuid`);
    const h = recording();
    const s = await fx.drainDueEpochEffects({ handlers: h.handlers });
    expect(s.done).toBeGreaterThanOrEqual(1);
    expect(h.ran.filter((x) => x.missionId === missionId)).toHaveLength(1);
    expect((await rows()).map((x) => [x.status, x.attempt_count])).toEqual([['done', 2]]);
  });

  test('the PR deliveries\' drain never claims an epoch row', async () => {
    await adopted();
    await fx.oweMissionRefresh(missionId, { trigger: 'start', now: AT });
    const claimed = await q<{ id: string; delivery_id: string | null }>(claimDueEffectsSql(1000));
    expect(claimed.every((c) => c.delivery_id !== null)).toBe(true);
    expect((await rows()).map((x) => x.status)).toEqual(['pending']);
  });
});
