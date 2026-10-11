/**
 * model.inference end to end on real Postgres
 * (docs/specs/model-inference-agent-capability.md, AC-12).
 *
 * The agent asks for a grant through the capability request service, a person
 * approves it, and the call runs through the production wiring
 * (`defaultModelInferenceDeps`: the grant service and the durable ledger). Only
 * the team's key route and the provider are fakes, so no funded key is needed.
 * Every refusal (pending, denied, expired, revoked, wrong model, over budget,
 * another team) must make zero provider calls.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import type { DecideParams, DecideResult, DecisionQuestions } from '@builddai/ai-kit/decide';
import { parseCapabilityRequest } from '@/lib/capability-grants';
import { decideCapabilityRequest, loadGrant, requestCapability } from '@/lib/capability-grants-store';
import {
  defaultModelInferenceDeps,
  invokeModelInference,
  type ModelInferenceBudget,
  type ModelInferenceDeps,
  type ModelInferenceUsage,
} from '@/lib/capability-model-inference';
import type { AgentPrincipal } from '@/lib/agent-capabilities/principal';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

beforeAll(() => {
  assertDbConfigured();
});

const JEV = 'typesafe/jev-1.13';
const JEV_VERSIONED = 'typesafe/jev-1.13-20260917';
const BUDGET: ModelInferenceBudget = {
  maxCalls: 10, maxTokensPerCall: 4_000, maxTotalTokens: 100_000,
  maxUsdPerCall: 0.01, maxUsd: 0.05, timeoutMs: 5_000, maxConcurrent: 2,
};
const REQUEST = {
  operation: 'decide' as const, model: JEV, state: 'test row',
  questions: { verdict: { type: 'choice' as const, instructions: 'Classify.', criteria: { flaky: null, real: null } } },
};
const rand = () => Math.random().toString(36).slice(2, 10);

async function seedRun(): Promise<AgentPrincipal> {
  const ws = await seedWorkspace();
  const key = `bld_${rand()}`;
  const [acct] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, auth_type, level, max_concurrent_workers)
    VALUES ('service', ${key}, ${key}, ${ws.teamId}::uuid, 'api', 'worker', 10) RETURNING id`);
  const taskId = await seedTask(ws.workspaceId, { status: 'in_progress' });
  const [wk] = await q<{ id: string }>(sql`
    INSERT INTO workers (workspace_id, account_id, task_id, name, runner, branch, status)
    VALUES (${ws.workspaceId}::uuid, ${acct.id}::uuid, ${taskId}::uuid, ${`w-${rand()}`}, 'runner', ${`b-${rand()}`}, 'running')
    RETURNING id`);
  return { kind: 'agent_run', via: 'task_token', workerId: wk.id, taskId, workspaceId: ws.workspaceId, teamId: ws.teamId, accountId: acct.id };
}

async function seedUser(): Promise<{ userId: string }> {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  return { userId: u.id };
}

/** The agent asks; the grant service records a pending request (no policy rule = ask a person). */
async function ask(principal: AgentPrincipal, budget: ModelInferenceBudget = BUDGET) {
  const parsed = parseCapabilityRequest({
    capability: 'model.inference', provider: 'openrouter', models: [JEV], operations: ['decide'], budget, reason: 'classify test rows',
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const out = await requestCapability(principal, parsed.request);
  if (!out.ok || !out.grant) throw new Error(`request refused: ${JSON.stringify(out)}`);
  expect(out.resolution.kind).toBe('pending_approval');
  return out.grant.id;
}

async function decide(grantId: string, decision: 'approve' | 'deny' | 'revoke') {
  const row = await loadGrant(grantId);
  const out = await decideCapabilityRequest(row!, decision, await seedUser());
  if (!out.ok) throw new Error(`${decision} refused: ${JSON.stringify(out)}`);
}

/** Production deps with only the key route and the provider faked. */
function harness() {
  const calls: DecideParams<DecisionQuestions>[] = [];
  const usage: ModelInferenceUsage[] = [];
  const fakeDecide = async (p: DecideParams<DecisionQuestions>): Promise<DecideResult<DecisionQuestions>> => {
    calls.push(p);
    return {
      ok: true, answers: { verdict: { type: 'choice', choice: 'flaky', probabilities: { flaky: 0.9, real: 0.1 }, confidence: 0.9 } } as never,
      model: JEV_VERSIONED, usage: { inputTokens: 120, outputTokens: 4, costUsd: 0.0002 }, latencyMs: 30, attempts: 1,
    };
  };
  const deps: ModelInferenceDeps = {
    ...defaultModelInferenceDeps(() => {}),
    resolveRoute: async () => ({ apiKey: 'sk-test-fake', provider: 'openrouter', model: JEV }),
    decide: fakeDecide as ModelInferenceDeps['decide'],
    usage: u => { usage.push(u); },
  };
  return { deps, calls, usage };
}

async function grantUsage(grantId: string) {
  const [u] = await q<{ calls: number; usd_micros: string; in_flight: number }>(sql`
    SELECT calls, usd_micros, in_flight FROM capability_grant_usage WHERE grant_id = ${grantId}::uuid`);
  return u ? { calls: Number(u.calls), usdMicros: Number(u.usd_micros), inFlight: Number(u.in_flight) } : null;
}

describe('request → approve → invoke', () => {
  test('an approved grant answers with a receipt naming the model version, usage, cost and the run', async () => {
    const principal = await seedRun();
    const grantId = await ask(principal);
    await decide(grantId, 'approve');
    const h = harness();

    const r = await invokeModelInference(principal, REQUEST, h.deps);
    if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r)}`);
    expect(r.answers.verdict).toMatchObject({ type: 'choice', choice: 'flaky' });
    expect(r.receipt).toEqual({
      grantId, taskId: principal.taskId, workerId: principal.workerId,
      provider: 'openrouter', requestedModel: JEV, model: JEV_VERSIONED, operation: 'decide',
      inputTokens: 120, outputTokens: 4, costUsd: 0.0002, debitedUsd: 0.0002, costSource: 'provider', latencyMs: 30,
    });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ apiKey: 'sk-test-fake', model: JEV, maxAttempts: 1, decisionId: `agent:${principal.taskId}` });
    expect(await grantUsage(grantId)).toEqual({ calls: 1, usdMicros: 200, inFlight: 0 });
    expect(h.usage).toEqual([{ teamId: principal.teamId!, accountId: principal.accountId, receipt: r.receipt, outcome: 'ok' }]);
  });
});

describe('every refusal makes zero provider calls', () => {
  test('a request still pending approval', async () => {
    const principal = await seedRun();
    await ask(principal);
    const h = harness();
    expect(await invokeModelInference(principal, REQUEST, h.deps)).toMatchObject({ ok: false, status: 403, code: 'no_grant' });
    expect(h.calls).toHaveLength(0);
  });

  test('a denied request', async () => {
    const principal = await seedRun();
    const grantId = await ask(principal);
    await decide(grantId, 'deny');
    const h = harness();
    expect(await invokeModelInference(principal, REQUEST, h.deps)).toMatchObject({ ok: false, code: 'no_grant' });
    expect(h.calls).toHaveLength(0);
    expect(await grantUsage(grantId)).toBeNull();
  });

  test('an expired grant', async () => {
    const principal = await seedRun();
    const grantId = await ask(principal);
    await decide(grantId, 'approve');
    await q(sql`UPDATE capability_grants SET expires_at = now() - interval '1 second' WHERE id = ${grantId}::uuid`);
    const h = harness();
    expect(await invokeModelInference(principal, REQUEST, h.deps)).toMatchObject({ ok: false, code: 'no_grant' });
    expect(h.calls).toHaveLength(0);
    expect(await grantUsage(grantId)).toBeNull();
  });

  test('a grant revoked after it was used stops the next call', async () => {
    const principal = await seedRun();
    const grantId = await ask(principal);
    await decide(grantId, 'approve');
    const h = harness();
    expect((await invokeModelInference(principal, REQUEST, h.deps)).ok).toBe(true);
    await decide(grantId, 'revoke');
    expect(await invokeModelInference(principal, REQUEST, h.deps)).toMatchObject({ ok: false, code: 'no_grant' });
    expect(h.calls).toHaveLength(1);
    expect(await grantUsage(grantId)).toEqual({ calls: 1, usdMicros: 200, inFlight: 0 });
  });

  test('a model the grant does not name', async () => {
    const principal = await seedRun();
    const grantId = await ask(principal);
    await decide(grantId, 'approve');
    const h = harness();
    expect(await invokeModelInference(principal, { ...REQUEST, model: 'other/model-1' }, h.deps))
      .toMatchObject({ ok: false, status: 403, code: 'model_not_allowed', grantId });
    expect(h.calls).toHaveLength(0);
    expect(await grantUsage(grantId)).toBeNull();
  });

  test('a grant whose budget is spent', async () => {
    const principal = await seedRun();
    const grantId = await ask(principal, { ...BUDGET, maxCalls: 1 });
    await decide(grantId, 'approve');
    const h = harness();
    expect((await invokeModelInference(principal, REQUEST, h.deps)).ok).toBe(true);
    expect(await invokeModelInference(principal, REQUEST, h.deps)).toMatchObject({ ok: false, status: 429, code: 'calls_exhausted', grantId });
    expect(h.calls).toHaveLength(1);
  });

  test('a principal from another team naming this run', async () => {
    const owner = await seedRun();
    const grantId = await ask(owner);
    await decide(grantId, 'approve');
    const other = await seedRun();
    const h = harness();
    // Another team's caller cannot borrow the run's grant, even naming its task and worker.
    expect(await invokeModelInference({ ...owner, teamId: other.teamId, accountId: other.accountId }, REQUEST, h.deps))
      .toMatchObject({ ok: false, code: 'no_grant' });
    // Nor can its own run, which holds no grant.
    expect(await invokeModelInference(other, REQUEST, h.deps)).toMatchObject({ ok: false, code: 'no_grant' });
    expect(h.calls).toHaveLength(0);
    expect(await grantUsage(grantId)).toBeNull();
  });
});
