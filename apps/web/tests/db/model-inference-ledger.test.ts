/**
 * The model.inference grant source and budget ledger, against real Postgres
 * (docs/specs/model-inference-agent-capability.md).
 *
 * The unit suite drives an in-memory reference ledger; these pin the SQL that
 * has to carry the same rule: N concurrent reserves on one grant never
 * overdraw it (the headroom check is one INSERT … ON CONFLICT DO UPDATE …
 * WHERE, not a read then a write), settle swaps the reservation for the debit
 * exactly once, a crashed call's reservation is swept at its full amount, a
 * grant that stopped being live reserves nothing, and a grant on an ended
 * task is not a live grant.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import type { DecideParams, DecideResult, DecisionQuestions } from '@builddai/ai-kit/decide';
import { capabilityGrantSource } from '@/lib/capability-grants-store';
import { modelInferenceLedger, sweepStaleReservations } from '@/lib/capability-model-inference-ledger';
import {
  invokeModelInference,
  type ModelInferenceBudget,
  type ModelInferenceDeps,
  type ModelInferenceReservation,
} from '@/lib/capability-model-inference';
import type { AgentPrincipal } from '@/lib/agent-capabilities/principal';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

beforeAll(() => {
  assertDbConfigured();
});

const JEV = 'typesafe/jev-1.13';
const BUDGET: ModelInferenceBudget = {
  maxCalls: 100, maxTokensPerCall: 4_000, maxTotalTokens: 1_000_000,
  maxUsdPerCall: 0.01, maxUsd: 0.05, timeoutMs: 5_000, maxConcurrent: 8,
};
const rand = () => Math.random().toString(36).slice(2, 10);

async function seedGrant(o: { budget?: ModelInferenceBudget; taskStatus?: string; status?: string; expiresInMs?: number; revoked?: boolean } = {}) {
  const ws = await seedWorkspace();
  const key = `bld_${rand()}`;
  const [acct] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, auth_type, level, max_concurrent_workers)
    VALUES ('service', ${key}, ${key}, ${ws.teamId}::uuid, 'api', 'worker', 10) RETURNING id`);
  const taskId = await seedTask(ws.workspaceId, { status: o.taskStatus ?? 'in_progress' });
  const [wk] = await q<{ id: string }>(sql`
    INSERT INTO workers (workspace_id, account_id, task_id, name, runner, branch, status)
    VALUES (${ws.workspaceId}::uuid, ${acct.id}::uuid, ${taskId}::uuid, ${`w-${rand()}`}, 'runner', ${`b-${rand()}`}, 'running')
    RETURNING id`);
  const scope = { models: [JEV], operations: ['decide'], budget: o.budget ?? BUDGET };
  const expiresAt = new Date(Date.now() + (o.expiresInMs ?? 60 * 60_000));
  const [g] = await q<{ id: string }>(sql`
    INSERT INTO capability_grants (team_id, workspace_id, task_id, worker_id, capability, provider, risk, scope, status,
      decided_by, decided_at, ttl_seconds, expires_at, revoked_at, dedupe_key)
    VALUES (${ws.teamId}::uuid, ${ws.workspaceId}::uuid, ${taskId}::uuid, ${wk.id}::uuid, 'model.inference', 'openrouter', 'query',
      ${JSON.stringify(scope)}::jsonb, ${o.status ?? 'granted'}, 'human', now(), 3600, ${expiresAt.toISOString()}::timestamptz,
      ${o.revoked ? new Date().toISOString() : null}::timestamptz, ${`dk-${rand()}`})
    RETURNING id`);
  const principal: AgentPrincipal = {
    kind: 'agent_run', via: 'task_token', workerId: wk.id, taskId, workspaceId: ws.workspaceId, teamId: ws.teamId, accountId: acct.id,
  };
  return { grantId: g.id, taskId, workerId: wk.id, principal };
}

const reservation = (grantId: string, o: Partial<ModelInferenceReservation> = {}): ModelInferenceReservation => ({
  grantId, reservationId: crypto.randomUUID(), usd: BUDGET.maxUsdPerCall, tokens: 100, ...o,
});

async function usage(grantId: string) {
  const [u] = await q<{ calls: number; tokens: string; usd_micros: string; in_flight: number }>(sql`
    SELECT calls, tokens, usd_micros, in_flight FROM capability_grant_usage WHERE grant_id = ${grantId}::uuid`);
  return u ? { calls: Number(u.calls), tokens: Number(u.tokens), usdMicros: Number(u.usd_micros), inFlight: Number(u.in_flight) } : null;
}
const openReservations = async (grantId: string) =>
  (await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM capability_grant_reservations WHERE grant_id = ${grantId}::uuid AND settled_at IS NULL`))[0].n;

describe('reserve: one conditional statement, never overdrawn', () => {
  test('20 concurrent reserves against a 5-reservation dollar budget: exactly 5 succeed', async () => {
    const { grantId } = await seedGrant();
    const results = await Promise.all(Array.from({ length: 20 }, () => modelInferenceLedger.reserve(reservation(grantId), BUDGET)));
    expect(results.filter(r => r.ok)).toHaveLength(5);
    expect(results.filter(r => !r.ok).every(r => !r.ok && r.reason === 'budget_exhausted')).toBe(true);
    expect(await usage(grantId)).toEqual({ calls: 5, tokens: 500, usdMicros: 50_000, inFlight: 5 });
    expect(await openReservations(grantId)).toBe(5);
  });

  test('the in-flight ceiling holds under concurrency, including the very first insert', async () => {
    const budget = { ...BUDGET, maxConcurrent: 3, maxUsd: 1 };
    const { grantId } = await seedGrant({ budget });
    const results = await Promise.all(Array.from({ length: 12 }, () => modelInferenceLedger.reserve(reservation(grantId), budget)));
    expect(results.filter(r => r.ok)).toHaveLength(3);
    expect(results.filter(r => !r.ok && r.reason === 'concurrency_limit')).toHaveLength(9);
    expect((await usage(grantId))!.inFlight).toBe(3);
  });

  test('call and token ceilings refuse with their own codes', async () => {
    const calls = { ...BUDGET, maxCalls: 1 };
    const a = await seedGrant({ budget: calls });
    expect((await modelInferenceLedger.reserve(reservation(a.grantId), calls)).ok).toBe(true);
    expect(await modelInferenceLedger.reserve(reservation(a.grantId), calls)).toEqual({ ok: false, reason: 'calls_exhausted' });

    const toks = { ...BUDGET, maxTotalTokens: 150 };
    const b = await seedGrant({ budget: toks });
    expect((await modelInferenceLedger.reserve(reservation(b.grantId), toks)).ok).toBe(true);
    expect(await modelInferenceLedger.reserve(reservation(b.grantId), toks)).toEqual({ ok: false, reason: 'tokens_exhausted' });
  });

  test('a revoked, expired or no-longer-granted grant reserves nothing', async () => {
    for (const o of [{ revoked: true }, { expiresInMs: -1_000 }, { status: 'revoked' }]) {
      const { grantId } = await seedGrant(o);
      const r = await modelInferenceLedger.reserve(reservation(grantId), BUDGET);
      expect(r.ok).toBe(false);
      expect(await usage(grantId)).toBeNull();
      expect(await openReservations(grantId)).toBe(0);
    }
  });
});

describe('settle and sweep', () => {
  test('settle swaps the reservation for the debit, frees the slot, and is idempotent', async () => {
    const { grantId } = await seedGrant();
    const r = reservation(grantId);
    expect((await modelInferenceLedger.reserve(r, BUDGET)).ok).toBe(true);
    const s = { grantId, reservationId: r.reservationId, debitUsd: 0.0002, tokens: 124, costSource: 'provider' as const, outcome: 'ok' as const };
    await modelInferenceLedger.settle(s);
    await modelInferenceLedger.settle(s);
    expect(await usage(grantId)).toEqual({ calls: 1, tokens: 124, usdMicros: 200, inFlight: 0 });
    const [row] = await q<{ debit_usd_micros: string; outcome: string; cost_source: string }>(sql`
      SELECT debit_usd_micros, outcome, cost_source FROM capability_grant_reservations WHERE id = ${r.reservationId}::uuid`);
    expect(row).toMatchObject({ outcome: 'ok', cost_source: 'provider' });
    expect(Number(row.debit_usd_micros)).toBe(200);
  });

  test('a provider cost rounds up to the next micro-dollar; a call that never left releases everything', async () => {
    const { grantId } = await seedGrant();
    const a = reservation(grantId);
    await modelInferenceLedger.reserve(a, BUDGET);
    await modelInferenceLedger.settle({ grantId, reservationId: a.reservationId, debitUsd: 0.0000001, tokens: 10, costSource: 'provider', outcome: 'ok' });
    expect((await usage(grantId))!.usdMicros).toBe(1);

    const b = reservation(grantId);
    await modelInferenceLedger.reserve(b, BUDGET);
    await modelInferenceLedger.settle({ grantId, reservationId: b.reservationId, debitUsd: 0, tokens: 0, costSource: 'none', outcome: 'not_sent' });
    expect(await usage(grantId)).toEqual({ calls: 1, tokens: 10, usdMicros: 1, inFlight: 0 });
  });

  test('a crashed call is swept at its full reservation and its slot freed; a late settle changes nothing', async () => {
    const budget = { ...BUDGET, maxConcurrent: 1 };
    const { grantId } = await seedGrant({ budget });
    const crashed = reservation(grantId);
    expect((await modelInferenceLedger.reserve(crashed, budget)).ok).toBe(true);
    expect(await modelInferenceLedger.reserve(reservation(grantId), budget)).toEqual({ ok: false, reason: 'concurrency_limit' });

    await q(sql`UPDATE capability_grant_reservations SET reserved_at = now() - interval '10 minutes' WHERE id = ${crashed.reservationId}::uuid`);
    // The next reserve sweeps this grant first, so the slot is free again.
    expect((await modelInferenceLedger.reserve(reservation(grantId), budget)).ok).toBe(true);
    const [row] = await q<{ outcome: string; debit_usd_micros: string }>(sql`
      SELECT outcome, debit_usd_micros FROM capability_grant_reservations WHERE id = ${crashed.reservationId}::uuid`);
    expect(row.outcome).toBe('stale');
    expect(Number(row.debit_usd_micros)).toBe(10_000);
    expect(await usage(grantId)).toEqual({ calls: 2, tokens: 200, usdMicros: 20_000, inFlight: 1 });

    await modelInferenceLedger.settle({ grantId, reservationId: crashed.reservationId, debitUsd: 0, tokens: 0, costSource: 'provider', outcome: 'ok' });
    expect(await usage(grantId)).toEqual({ calls: 2, tokens: 200, usdMicros: 20_000, inFlight: 1 });
  });

  test('an unscoped sweep leaves fresh reservations alone', async () => {
    const { grantId } = await seedGrant();
    await modelInferenceLedger.reserve(reservation(grantId), BUDGET);
    await sweepStaleReservations();
    expect(await openReservations(grantId)).toBe(1);
  });
});

describe('grant source', () => {
  test('a live grant maps to the adapter shape; one on an ended task is not live', async () => {
    const live = await seedGrant();
    const g = await capabilityGrantSource.findLiveGrant({ principal: live.principal, capability: 'model.inference' });
    expect(g).toMatchObject({ grantId: live.grantId, provider: 'openrouter', models: [JEV], operations: ['decide'], budget: BUDGET });

    const ended = await seedGrant({ taskStatus: 'completed' });
    expect(await capabilityGrantSource.findLiveGrant({ principal: ended.principal, capability: 'model.inference' })).toBeNull();
  });
});

describe('invokeModelInference over the real grant source and ledger', () => {
  test('concurrent agent calls stop at the dollar budget, and each debit is the provider cost', async () => {
    const { principal, grantId } = await seedGrant();
    let calls = 0;
    const decide = async (_p: DecideParams<DecisionQuestions>): Promise<DecideResult<DecisionQuestions>> => {
      calls++;
      await new Promise(r => setTimeout(r, 50));
      return {
        ok: true, answers: { verdict: { type: 'choice', choice: 'flaky', probabilities: { flaky: 0.9, real: 0.1 }, confidence: 0.9 } } as never,
        model: 'typesafe/jev-1.13-20260917', usage: { inputTokens: 120, outputTokens: 4, costUsd: 0.0002 }, latencyMs: 50, attempts: 1,
      };
    };
    const deps: ModelInferenceDeps = {
      grants: capabilityGrantSource,
      ledger: modelInferenceLedger,
      resolveRoute: async () => ({ apiKey: 'sk-test-fake', provider: 'openrouter', model: JEV }),
      decide: decide as ModelInferenceDeps['decide'],
      audit: () => {},
    };
    const request = {
      operation: 'decide' as const, model: JEV, state: 'row',
      questions: { verdict: { type: 'choice' as const, instructions: 'Classify.', criteria: { flaky: null, real: null } } },
    };
    const results = await Promise.all(Array.from({ length: 10 }, () => invokeModelInference(principal, request, deps)));
    // 0.05 / 0.01 reserved per call: at most five in flight at once, whatever settles later.
    expect(calls).toBeLessThanOrEqual(5);
    expect(results.filter(r => r.ok)).toHaveLength(calls);
    const u = (await usage(grantId))!;
    expect(u.inFlight).toBe(0);
    expect(u.calls).toBe(calls);
    expect(u.usdMicros).toBe(calls * 200);
  });
});
