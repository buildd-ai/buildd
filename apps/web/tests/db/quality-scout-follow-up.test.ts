/**
 * Quality Scout follow-up claim and dismissal, against real Postgres.
 *
 * The unit tests drive a fake store; these assert the SQL that fake stands in
 * for, which a mocked `db` cannot see: the follow-up is inserted behind the
 * same hold gate the claim route applies (so a losing run's task is never
 * claimable), the claim refuses a dismissed finding, only the Scout's own hold
 * is released, the Scout's own cancels are told apart from a person's, and a
 * dismissal survives a recurrence that read the row before it.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { qualityScoutFindings, tasks } from '@buildd/core/db/schema';
import { scoutFindingRow, dbScoutFindingStore } from '@buildd/core/quality-scout/ledger';
import type { ScoutFinding, ScoutRun } from '@buildd/core/quality-scout/types';
import { taskNotHeld } from '@/app/api/workers/claim/held-gate';
import {
  actOnScoutFinding,
  dbScoutActionStore,
  DEFAULT_SCOUT_ACTION_POLICY,
  dismissQualityScoutFinding,
  type ScoutActionStore,
} from '@/lib/quality-scout-actions';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const SHA = 'a'.repeat(40);
const NOW = new Date('2026-10-05T12:00:00Z');
let workspaceId: string;
let n = 0;

beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});

// Announcing reaches Pusher and the dispatch transport; the claim is what is under test.
const store: ScoutActionStore = { ...dbScoutActionStore, announce: async () => {} };

const run = (): ScoutRun => ({
  id: crypto.randomUUID(),
  workspaceId,
  missionId: null,
  trigger: 'manual',
  mode: 'propose',
  status: 'running',
  candidate: { ref: 'main', sha: SHA },
  prior: null,
  budget: { maxProbes: 4, maxCostUsd: null },
  policyVersion: 'scout-v1',
  startedAt: NOW.toISOString(),
  completedAt: null,
  error: null,
});

async function seedFinding(over: Partial<ScoutFinding> = {}): Promise<ScoutFinding> {
  const r = crypto.randomUUID();
  const f: ScoutFinding = {
    workspaceId,
    signature: `sig-${Date.now().toString(36)}-${n++}`,
    recurrenceKey: 'quality-scout:cand-1',
    checkId: 'quality-scout:cand-1',
    family: 'contract',
    invariant: 'GET /health answers 200.',
    severity: 'high',
    confidence: 1,
    observed: 'GET /health -> 500',
    evidenceRefs: [{ kind: 'http-exchange', ref: 'ev-1' }],
    reproducibility: 'deterministic',
    state: 'open',
    actionState: 'none',
    actionTaskId: null,
    occurrenceCount: 1,
    regressionCount: 0,
    firstSeenRunId: r,
    firstSeenSha: SHA,
    lastSeenRunId: r,
    lastSeenSha: SHA,
    firstSeenAt: NOW.toISOString(),
    lastSeenAt: NOW.toISOString(),
    resolvedRunId: null,
    resolvedSha: null,
    resolvedAt: null,
    dismissedReason: null,
    dismissedAt: null,
    dismissedBy: null,
    ...over,
  };
  await db.insert(qualityScoutFindings).values(scoutFindingRow(f));
  return f;
}

const findingRow = async (signature: string) =>
  (await db.select().from(qualityScoutFindings).where(eq(qualityScoutFindings.signature, signature)))[0];

/** The claim route's own hold gate. */
async function passesHoldGate(taskId: string): Promise<boolean> {
  const rows = await q(sql`SELECT id FROM tasks WHERE id = ${taskId}::uuid AND ${taskNotHeld()}`);
  return rows.length === 1;
}

const ctx = { mode: 'propose' as const, policy: DEFAULT_SCOUT_ACTION_POLICY, now: NOW };

describe('the follow-up is never claimable before its claim is won', () => {
  test('insertTask writes it held; the claim route gate refuses it', async () => {
    const f = await seedFinding();
    const { id } = await store.insertTask({
      workspaceId, signature: f.signature, title: 't', description: 'd', priority: 6, category: 'bug',
      kind: 'fix', runId: f.lastSeenRunId, missionId: null, followUpOf: null,
    });
    expect(await passesHoldGate(id)).toBe(false);
    await store.deleteTask(id);
    expect((await q(sql`SELECT id FROM tasks WHERE id = ${id}::uuid`)).length).toBe(0);
  });

  test('a won claim releases the hold before the task is announced', async () => {
    const f = await seedFinding();
    const r = await actOnScoutFinding(f, run(), ctx, store);
    expect(r.outcome).toBe('filed');
    expect(await passesHoldGate(r.taskId!)).toBe(true);
    expect((await findingRow(f.signature)).actionTaskId).toBe(r.taskId);
  });

  test('releaseHold leaves a person\'s hold in place', async () => {
    const id = await seedTask(workspaceId);
    await db.update(tasks).set({ context: { heldBy: { at: NOW.toISOString(), userId: null, reason: 'waiting on me' } } }).where(eq(tasks.id, id));
    await store.releaseHold(id);
    expect(await passesHoldGate(id)).toBe(false);
  });

  test('a refresh lifts a hold a crashed winner never released', async () => {
    const f = await seedFinding();
    const { id } = await store.insertTask({
      workspaceId, signature: f.signature, title: 't', description: 'd', priority: 6, category: 'bug',
      kind: 'fix', runId: f.lastSeenRunId, missionId: null, followUpOf: null,
    });
    expect(await store.claimFollowUp(workspaceId, f.signature, id, [])).toBe(true);
    expect(await passesHoldGate(id)).toBe(false);
    await store.refreshTask(id, f, run());
    expect(await passesHoldGate(id)).toBe(true);
  });

  test('the claim refuses a dismissed finding', async () => {
    const f = await seedFinding({ state: 'dismissed', dismissedReason: 'no', dismissedBy: 'user:u', dismissedAt: NOW.toISOString() });
    const id = await seedTask(workspaceId);
    expect(await store.claimFollowUp(workspaceId, f.signature, id, [])).toBe(false);
    expect(await store.raiseActionState(workspaceId, f.signature, 'proposed')).toBe(false);
  });
});

describe('dismissal', () => {
  test('a person dismisses with a reason; the unclaimed follow-up is cancelled by the Scout', async () => {
    const f = await seedFinding();
    const filed = await actOnScoutFinding(f, run(), ctx, store);
    const res = await dismissQualityScoutFinding({ workspaceId, signature: f.signature, reason: 'expected', by: 'user:u-1' }, store);
    expect(res).toEqual({ status: 'dismissed', followUp: 'cancelled', taskId: filed.taskId });
    expect(await findingRow(f.signature)).toMatchObject({ state: 'dismissed', dismissedReason: 'expected', dismissedBy: 'user:u-1' });
    expect(await store.taskStatus(filed.taskId!)).toBe('cancelled');
    expect(await store.cancelledByScout(filed.taskId!)).toBe(true);
    expect((await dismissQualityScoutFinding({ workspaceId, signature: f.signature, reason: 'x', by: 'user:u-2' }, store)).status).toBe('already_dismissed');
    expect((await dismissQualityScoutFinding({ workspaceId, signature: 'no-such-sig', reason: 'x', by: 'user:u-2' }, store)).status).toBe('not_found');
  });

  test('a follow-up a person cancelled is not the Scout\'s: the next failing run dismisses instead of re-filing', async () => {
    const f = await seedFinding();
    const filed = await actOnScoutFinding(f, run(), ctx, store);
    await db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, filed.taskId!));
    expect(await store.cancelledByScout(filed.taskId!)).toBe(false);
    const fresh = await dbScoutFindingStore.find(workspaceId, f.signature);
    const again = await actOnScoutFinding({ ...fresh!, lastSeenSha: 'b'.repeat(40) }, run(), ctx, store);
    expect(again.outcome).toBe('dismissed');
    expect(await findingRow(f.signature)).toMatchObject({ state: 'dismissed', dismissedBy: `follow-up-cancelled:${filed.taskId}` });
    const count = await q(sql`SELECT count(*)::int AS n FROM tasks WHERE context->'qualityScout'->>'signature' = ${f.signature}`);
    expect(count[0].n).toBe(1);
  });

  test('a recurrence that read the row before the dismissal cannot write it back to open', async () => {
    const f = await seedFinding();
    await dismissQualityScoutFinding({ workspaceId, signature: f.signature, reason: 'expected', by: 'user:u-1' }, store);
    // `f` is the stale, open read; same occurrence count as the row.
    expect(await dbScoutFindingStore.update({ ...f, occurrenceCount: 2, lastSeenRunId: crypto.randomUUID() }, 1)).toBe(false);
    expect((await findingRow(f.signature)).state).toBe('dismissed');
  });
});
