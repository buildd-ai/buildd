import { describe, it, expect, mock } from 'bun:test';
import type { DecideParams, DecideResult, DecisionQuestions } from '@builddai/ai-kit/decide';
import type { AgentPrincipal } from '@/lib/agent-capabilities/principal';
import {
  checkGrant,
  invokeModelInference,
  parseModelInferenceRequest,
  reserveRefusal,
  defaultModelInferenceDeps,
  NO_GRANT_SERVICE,
  NO_LEDGER,
  type GrantUsage,
  type ModelInferenceAudit,
  type ModelInferenceBudget,
  type ModelInferenceDeps,
  type ModelInferenceGrant,
  type ModelInferenceLedger,
  type ModelInferenceRequest,
  type ModelInferenceSettlement,
  type ResolvedInferenceRoute,
} from './capability-model-inference';

// ── fixtures (synthetic: no live key, no network) ────────────────────────────

const NOW = new Date('2026-10-08T12:00:00Z');
const JEV = 'typesafe/jev-1.13';
const FAKE_KEY = 'sk-or-v1-FAKE-never-shown';

const PRINCIPAL: AgentPrincipal = {
  kind: 'agent_run', via: 'task_token',
  workerId: '11111111-1111-4111-8111-111111111111',
  taskId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  teamId: '44444444-4444-4444-8444-444444444444',
  accountId: '55555555-5555-4555-8555-555555555555',
};

const BUDGET: ModelInferenceBudget = {
  maxCalls: 10, maxTokensPerCall: 4_000, maxTotalTokens: 40_000,
  maxUsdPerCall: 0.01, maxUsd: 0.05, timeoutMs: 5_000, maxConcurrent: 4,
};

function grant(o: Partial<ModelInferenceGrant> = {}): ModelInferenceGrant {
  return {
    grantId: '66666666-6666-4666-8666-666666666666',
    capability: 'model.inference',
    teamId: PRINCIPAL.teamId!, workspaceId: PRINCIPAL.workspaceId, taskId: PRINCIPAL.taskId, workerId: PRINCIPAL.workerId,
    provider: 'openrouter', models: [JEV], operations: ['decide'],
    expiresAt: new Date(NOW.getTime() + 60 * 60_000), revokedAt: null,
    budget: BUDGET,
    ...o,
  };
}

const REQUEST: ModelInferenceRequest = {
  operation: 'decide',
  model: JEV,
  state: { item: 'The build failed on a flaky network test.' },
  questions: { verdict: { type: 'choice', instructions: 'Classify the failure.', criteria: { flaky: null, real: null } } },
};

const ROUTE: ResolvedInferenceRoute = { apiKey: FAKE_KEY, provider: 'openrouter', model: JEV };

type FakeDecide = ReturnType<typeof mock<(p: DecideParams<DecisionQuestions>) => Promise<DecideResult<DecisionQuestions>>>>;

/** A fake Jev responder: answers the one choice question, reports a cost. */
function jevResponder(o: { costUsd?: number | null; model?: string } = {}): FakeDecide {
  return mock(async (_p: DecideParams<DecisionQuestions>) => ({
    ok: true as const,
    answers: { verdict: { type: 'choice', choice: 'flaky', probabilities: { flaky: 0.9, real: 0.1 }, confidence: 0.9 } } as never,
    model: o.model ?? 'typesafe/jev-1.13-20260917',
    usage: { inputTokens: 120, outputTokens: 4, costUsd: o.costUsd === undefined ? 0.0002 : o.costUsd },
    latencyMs: 40,
    attempts: 1,
  }));
}

/**
 * A reference ledger with the semantics a durable one must have: reserve is
 * check-and-increment in one step (here, synchronous; in Postgres, one
 * conditional UPDATE … RETURNING). Test-only — in-process state is not a ledger.
 */
function memoryLedger(start: Partial<GrantUsage> = {}) {
  const usage: GrantUsage = { calls: 0, tokens: 0, usd: 0, inFlight: 0, ...start };
  const held = new Map<string, { usd: number; tokens: number }>();
  const settlements: ModelInferenceSettlement[] = [];
  const reserve = mock(async (r: { reservationId: string; usd: number; tokens: number }, budget: ModelInferenceBudget) => {
    const refusal = reserveRefusal(usage, budget, r);
    if (refusal) return { ok: false as const, reason: refusal };
    usage.calls += 1; usage.tokens += r.tokens; usage.usd += r.usd; usage.inFlight += 1;
    held.set(r.reservationId, { usd: r.usd, tokens: r.tokens });
    return { ok: true as const };
  });
  const settle = mock(async (s: ModelInferenceSettlement) => {
    const h = held.get(s.reservationId);
    if (!h) return;
    held.delete(s.reservationId);
    usage.inFlight -= 1;
    usage.usd += s.debitUsd - h.usd;
    usage.tokens += s.tokens - h.tokens;
    if (s.outcome === 'not_sent') usage.calls -= 1;
    settlements.push(s);
  });
  const ledger: ModelInferenceLedger = { reserve, settle };
  return { ledger, usage, settlements, reserve, settle };
}

function setup(o: {
  grant?: ModelInferenceGrant | null;
  route?: ResolvedInferenceRoute | null;
  decide?: FakeDecide;
  ledger?: ModelInferenceLedger;
  findLiveGrant?: ModelInferenceDeps['grants']['findLiveGrant'];
} = {}) {
  const decide = o.decide ?? jevResponder();
  const mem = memoryLedger();
  const audits: ModelInferenceAudit[] = [];
  const resolveRoute = mock(async () => (o.route === undefined ? ROUTE : o.route));
  const g = o.grant === undefined ? grant() : o.grant;
  const deps: ModelInferenceDeps = {
    grants: { findLiveGrant: o.findLiveGrant ?? (async () => g) },
    ledger: o.ledger ?? mem.ledger,
    resolveRoute,
    decide: decide as unknown as ModelInferenceDeps['decide'],
    audit: row => { audits.push(row); },
    now: () => NOW,
    newId: (() => { let n = 0; return () => `res-${++n}`; })(),
  };
  return { deps, decide, mem, audits, resolveRoute };
}

async function expectNoSpend(s: ReturnType<typeof setup>, code: string) {
  const r = await invokeModelInference(PRINCIPAL, REQUEST, s.deps);
  expect(r.ok).toBe(false);
  expect((r as { code: string }).code).toBe(code);
  expect(s.decide).toHaveBeenCalledTimes(0);
  expect(s.mem.usage.usd).toBe(0);
  expect(s.audits.at(-1)).toMatchObject({ decision: 'refused', reasonCode: code });
  return r;
}

// ── refusals: zero provider calls ────────────────────────────────────────────

describe('invokeModelInference — refusals make no provider call', () => {
  it('refuses with no grant (and the default grant source has none)', async () => {
    await expectNoSpend(setup({ grant: null }), 'no_grant');
    expect(await NO_GRANT_SERVICE.findLiveGrant({ principal: PRINCIPAL, capability: 'model.inference' })).toBeNull();
  });

  it('a throwing grant lookup reads as no grant', async () => {
    await expectNoSpend(setup({ findLiveGrant: async () => { throw new Error('db down'); } }), 'no_grant');
  });

  for (const [field, value] of [
    ['workspaceId', '77777777-7777-4777-8777-777777777777'],
    ['taskId', '88888888-8888-4888-8888-888888888888'],
    ['workerId', '99999999-9999-4999-8999-999999999999'],
    ['teamId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
  ] as const) {
    it(`refuses a grant for another ${field}`, async () => {
      const s = setup({ grant: grant({ [field]: value }) });
      const r = await expectNoSpend(s, 'grant_mismatch');
      expect(r.ok === false && r.status).toBe(403);
      expect(s.resolveRoute).toHaveBeenCalledTimes(0); // no key resolved either
    });
  }

  it('refuses an expired grant, including one expiring this instant', async () => {
    await expectNoSpend(setup({ grant: grant({ expiresAt: new Date(NOW.getTime() - 1) }) }), 'grant_expired');
    await expectNoSpend(setup({ grant: grant({ expiresAt: NOW }) }), 'grant_expired');
  });

  it('refuses a revoked grant even before it expires', async () => {
    await expectNoSpend(setup({ grant: grant({ revokedAt: new Date(NOW.getTime() - 1000) }) }), 'grant_revoked');
  });

  it('refuses a model the grant does not name exactly', async () => {
    await expectNoSpend(setup({ grant: grant({ models: ['typesafe/jev-latest'] }) }), 'model_not_allowed');
  });

  it("refuses when the team's configured model is not the one asked for", async () => {
    await expectNoSpend(setup({ route: { ...ROUTE, model: 'some/other-model' } }), 'model_not_allowed');
  });

  it('refuses when the team routes through a provider the grant does not name', async () => {
    await expectNoSpend(setup({ route: { ...ROUTE, provider: 'litellm' } }), 'provider_not_allowed');
  });

  it('refuses an operation the grant does not allow', async () => {
    await expectNoSpend(setup({ grant: grant({ operations: [] }) }), 'operation_not_allowed');
  });

  it('refuses a grant whose budget exceeds the platform ceilings', async () => {
    await expectNoSpend(setup({ grant: grant({ budget: { ...BUDGET, maxUsd: 10_000 } }) }), 'budget_invalid');
    await expectNoSpend(setup({ grant: grant({ budget: { ...BUDGET, maxUsdPerCall: 0 } }) }), 'budget_invalid');
    await expectNoSpend(setup({ grant: grant({ budget: { ...BUDGET, maxConcurrent: 1_000 } }) }), 'budget_invalid');
  });

  it('refuses a request larger than the grant allows per call', async () => {
    await expectNoSpend(setup({ grant: grant({ budget: { ...BUDGET, maxTokensPerCall: 5 } }) }), 'tokens_over_limit');
  });

  it('refuses with no team key, and never falls back to a platform key', async () => {
    await expectNoSpend(setup({ route: null }), 'missing_key');
  });

  it('refuses when no ledger exists (the default) rather than spending unaccounted', async () => {
    const s = setup({ ledger: NO_LEDGER });
    const r = await expectNoSpend(s, 'ledger_unavailable');
    expect(r.ok === false && r.status).toBe(503);
    expect(defaultModelInferenceDeps(() => {}).ledger).toBe(NO_LEDGER);
    expect(defaultModelInferenceDeps(() => {}).grants).toBe(NO_GRANT_SERVICE);
  });

  it('a throwing ledger reads as unavailable', async () => {
    await expectNoSpend(setup({ ledger: { reserve: async () => { throw new Error('x'); }, settle: async () => {} } }), 'ledger_unavailable');
  });

  it('refuses when the dollar budget is spent', async () => {
    const mem = memoryLedger({ usd: 0.045 });
    const s = setup({ ledger: mem.ledger });
    await expectNoSpend(s, 'budget_exhausted');
  });

  it('refuses when the grant has used its calls', async () => {
    const mem = memoryLedger({ calls: BUDGET.maxCalls });
    await expectNoSpend(setup({ ledger: mem.ledger }), 'calls_exhausted');
  });

  it('refuses a principal with no team', async () => {
    const s = setup();
    const r = await invokeModelInference({ ...PRINCIPAL, teamId: null }, REQUEST, s.deps);
    expect(r.ok === false && r.code).toBe('no_team');
    expect(s.decide).toHaveBeenCalledTimes(0);
  });
});

// ── allowed calls ────────────────────────────────────────────────────────────

describe('invokeModelInference — an allowed call', () => {
  it('answers through the fake Jev responder and records cost and model version', async () => {
    const s = setup();
    const r = await invokeModelInference(PRINCIPAL, REQUEST, s.deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answers.verdict).toMatchObject({ type: 'choice', choice: 'flaky' });
    expect(r.receipt).toEqual({
      grantId: grant().grantId, provider: 'openrouter', model: 'typesafe/jev-1.13-20260917', operation: 'decide',
      inputTokens: 120, outputTokens: 4, costUsd: 0.0002, debitedUsd: 0.0002, costSource: 'provider', latencyMs: 40,
    });
    expect(s.decide).toHaveBeenCalledTimes(1);
    const sent = s.decide.mock.calls[0][0];
    expect(sent.apiKey).toBe(FAKE_KEY);
    expect(sent.model).toBe(JEV);
    expect(sent.maxAttempts).toBe(1); // one reservation, one provider request
    expect(sent.timeoutMs).toBe(BUDGET.timeoutMs);
    expect(s.mem.usage).toMatchObject({ calls: 1, tokens: 124, inFlight: 0 });
    expect(s.mem.usage.usd).toBeCloseTo(0.0002, 10);
    expect(s.audits.at(-1)).toMatchObject({ decision: 'allowed', reasonCode: null, grantId: grant().grantId });
  });

  it('never puts the key in the receipt, the result or the audit', async () => {
    const s = setup();
    const r = await invokeModelInference(PRINCIPAL, REQUEST, s.deps);
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(s.audits)).not.toContain(FAKE_KEY);
  });

  it('charges the full reservation when the provider reports no cost', async () => {
    const s = setup({ decide: jevResponder({ costUsd: null }) });
    const r = await invokeModelInference(PRINCIPAL, REQUEST, s.deps);
    expect(r.ok && r.receipt).toMatchObject({ costUsd: null, debitedUsd: BUDGET.maxUsdPerCall, costSource: 'reservation' });
    expect(s.mem.usage.usd).toBeCloseTo(BUDGET.maxUsdPerCall, 10);
  });

  it('charges the full reservation for a negative or non-finite reported cost', async () => {
    const s = setup({ decide: jevResponder({ costUsd: -5 }) });
    const r = await invokeModelInference(PRINCIPAL, REQUEST, s.deps);
    expect(r.ok && r.receipt.debitedUsd).toBe(BUDGET.maxUsdPerCall);
  });

  it('charges the reservation when the provider errors after the request was sent, and relays no body', async () => {
    const decide = mock(async () => ({ ok: false as const, error: { kind: 'provider_error' as const, status: 500, body: `echo ${FAKE_KEY}` }, latencyMs: 30, attempts: 1 }));
    const s = setup({ decide: decide as unknown as FakeDecide });
    const r = await invokeModelInference(PRINCIPAL, REQUEST, s.deps);
    expect(r.ok).toBe(false);
    if (r.ok || !('receipt' in r)) throw new Error('expected a receipt');
    expect(r.status).toBe(502);
    expect(r.code).toBe('provider_error');
    expect(r.receipt).toMatchObject({ debitedUsd: BUDGET.maxUsdPerCall, costSource: 'reservation' });
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(s.audits)).not.toContain(FAKE_KEY);
    expect(s.mem.usage.usd).toBeCloseTo(BUDGET.maxUsdPerCall, 10);
  });

  it('charges the reservation on a timeout', async () => {
    const decide = mock(async () => ({ ok: false as const, error: { kind: 'timeout' as const, timeoutMs: 5000 }, latencyMs: 5000, attempts: 1 }));
    const s = setup({ decide: decide as unknown as FakeDecide });
    const r = await invokeModelInference(PRINCIPAL, REQUEST, s.deps);
    expect(r.ok === false && r.status).toBe(504);
    expect(s.mem.usage.usd).toBeCloseTo(BUDGET.maxUsdPerCall, 10);
  });

  it('releases the reservation when the call provably never left (no attempts)', async () => {
    const decide = mock(async () => ({ ok: false as const, error: { kind: 'sdk_missing' as const, message: 'x' }, latencyMs: 0, attempts: 0 }));
    const s = setup({ decide: decide as unknown as FakeDecide });
    await invokeModelInference(PRINCIPAL, REQUEST, s.deps);
    expect(s.mem.usage).toEqual({ calls: 0, tokens: 0, usd: 0, inFlight: 0 });
    expect(s.mem.settlements[0]).toMatchObject({ debitUsd: 0, costSource: 'none', outcome: 'not_sent' });
  });

  it('a throwing transport is treated as sent and charged', async () => {
    const decide = mock(async () => { throw new Error('boom'); });
    const s = setup({ decide: decide as unknown as FakeDecide });
    const r = await invokeModelInference(PRINCIPAL, REQUEST, s.deps);
    expect(r.ok === false && r.code).toBe('transport');
    expect(s.mem.usage.usd).toBeCloseTo(BUDGET.maxUsdPerCall, 10);
  });

  it('caps the deadline at the time left on the grant', async () => {
    const s = setup({ grant: grant({ expiresAt: new Date(NOW.getTime() + 1_200) }) });
    await invokeModelInference(PRINCIPAL, REQUEST, s.deps);
    expect(s.decide.mock.calls[0][0].timeoutMs).toBe(1_200);
  });

  it('passes the gateway fetcher and endpoint from the route, never from the request', async () => {
    const gatewayFetch = (async () => new Response('{}')) as unknown as typeof fetch;
    const route: ResolvedInferenceRoute = { apiKey: FAKE_KEY, provider: 'litellm', model: 'team/model', endpoint: { kind: 'chat', baseURL: 'https://gw.example.com/v1', provider: 'openai' }, fetch: gatewayFetch };
    const s = setup({ route, grant: grant({ provider: 'litellm', models: ['team/model'] }) });
    await invokeModelInference(PRINCIPAL, { ...REQUEST, model: 'team/model' }, s.deps);
    const sent = s.decide.mock.calls[0][0];
    expect(sent.endpoint).toEqual(route.endpoint!);
    expect(sent.fetch).toBe(gatewayFetch);
  });

  it('a settle failure does not fail the call, and the reservation stays held', async () => {
    const mem = memoryLedger();
    const ledger: ModelInferenceLedger = { reserve: mem.ledger.reserve, settle: async () => { throw new Error('write failed'); } };
    const s = setup({ ledger });
    const r = await invokeModelInference(PRINCIPAL, REQUEST, s.deps);
    expect(r.ok).toBe(true);
    expect(mem.usage.usd).toBeCloseTo(BUDGET.maxUsdPerCall, 10); // over-counted, never under
    expect(mem.usage.inFlight).toBe(1);
  });
});

// ── abuse and concurrency ────────────────────────────────────────────────────

describe('invokeModelInference — concurrency', () => {
  it('concurrent calls never exceed the dollar ceiling', async () => {
    // maxUsd 0.05 / 0.01 per reservation ⇒ at most 5 in flight-or-spent.
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const inner = jevResponder();
    const decide = mock(async (p: DecideParams<DecisionQuestions>) => { await gate; return inner(p); });
    const s = setup({ decide: decide as unknown as FakeDecide, grant: grant({ budget: { ...BUDGET, maxConcurrent: 8, maxCalls: 100 } }) });
    const pending = Array.from({ length: 12 }, () => invokeModelInference(PRINCIPAL, REQUEST, s.deps));
    await new Promise(r => setTimeout(r, 0));
    release();
    const results = await Promise.all(pending);
    expect(decide).toHaveBeenCalledTimes(5);
    expect(results.filter(r => r.ok)).toHaveLength(5);
    expect(results.filter(r => !r.ok).every(r => !r.ok && r.code === 'budget_exhausted')).toBe(true);
    expect(s.mem.usage.usd).toBeLessThanOrEqual(BUDGET.maxUsd);
  });

  it('enforces the in-flight limit', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const inner = jevResponder();
    const decide = mock(async (p: DecideParams<DecisionQuestions>) => { await gate; return inner(p); });
    const s = setup({ decide: decide as unknown as FakeDecide, grant: grant({ budget: { ...BUDGET, maxConcurrent: 2 } }) });
    const pending = Array.from({ length: 4 }, () => invokeModelInference(PRINCIPAL, REQUEST, s.deps));
    await new Promise(r => setTimeout(r, 0));
    release();
    const results = await Promise.all(pending);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(results.filter(r => !r.ok && r.code === 'concurrency_limit')).toHaveLength(2);
  });

  it('re-reads the grant on every request: a revocation stops the next call', async () => {
    let current: ModelInferenceGrant = grant();
    const s = setup({ findLiveGrant: async () => current });
    expect((await invokeModelInference(PRINCIPAL, REQUEST, s.deps)).ok).toBe(true);
    current = grant({ revokedAt: NOW });
    const r = await invokeModelInference(PRINCIPAL, REQUEST, s.deps);
    expect(r.ok === false && r.code).toBe('grant_revoked');
    expect(s.decide).toHaveBeenCalledTimes(1);
  });
});

// ── pure rules ───────────────────────────────────────────────────────────────

describe('reserveRefusal', () => {
  const zero: GrantUsage = { calls: 0, tokens: 0, usd: 0, inFlight: 0 };
  it('allows within every ceiling', () => {
    expect(reserveRefusal(zero, BUDGET, { usd: 0.01, tokens: 100 })).toBeNull();
    expect(reserveRefusal({ ...zero, usd: 0.04 }, BUDGET, { usd: 0.01, tokens: 1 })).toBeNull();
  });
  it('names the ceiling that refuses', () => {
    expect(reserveRefusal({ ...zero, inFlight: 4 }, BUDGET, { usd: 0.01, tokens: 1 })).toBe('concurrency_limit');
    expect(reserveRefusal({ ...zero, calls: 10 }, BUDGET, { usd: 0.01, tokens: 1 })).toBe('calls_exhausted');
    expect(reserveRefusal({ ...zero, tokens: 39_999 }, BUDGET, { usd: 0.01, tokens: 2 })).toBe('tokens_exhausted');
    expect(reserveRefusal({ ...zero, usd: 0.0401 }, BUDGET, { usd: 0.01, tokens: 1 })).toBe('budget_exhausted');
  });
});

describe('checkGrant', () => {
  it('accepts a matching live grant', () => {
    expect(checkGrant(grant(), PRINCIPAL, REQUEST, NOW)).toBeNull();
  });
  it('rejects a grant for another capability', () => {
    expect(checkGrant(grant({ capability: 'github.repo_grant' as never }), PRINCIPAL, REQUEST, NOW)).toBe('grant_mismatch');
  });
  it('rejects an unparseable expiry', () => {
    expect(checkGrant(grant({ expiresAt: new Date('nope') }), PRINCIPAL, REQUEST, NOW)).toBe('grant_expired');
  });
});

describe('parseModelInferenceRequest', () => {
  const body = { model: JEV, state: 'x', questions: REQUEST.questions };

  it('accepts a bounded decide request, defaulting the operation', () => {
    const r = parseModelInferenceRequest(body);
    expect(r.ok && r.request.operation).toBe('decide');
  });

  for (const key of ['baseURL', 'baseUrl', 'endpoint', 'apiKey', 'api_key', 'headers', 'provider']) {
    it(`refuses an agent-supplied ${key}`, () => {
      expect(parseModelInferenceRequest({ ...body, [key]: 'https://evil.example' }).ok).toBe(false);
    });
  }

  it('refuses an unknown operation (no arbitrary proxying)', () => {
    expect(parseModelInferenceRequest({ ...body, operation: 'chat' }).ok).toBe(false);
  });

  it('refuses a model id that is not an exact id', () => {
    expect(parseModelInferenceRequest({ ...body, model: 'https://x/y z' }).ok).toBe(false);
    expect(parseModelInferenceRequest({ ...body, model: undefined }).ok).toBe(false);
  });

  it('refuses oversize state and too many questions', () => {
    expect(parseModelInferenceRequest({ ...body, state: 'x'.repeat(70 * 1024) }).ok).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`q${i}`, { type: 'noul', instructions: 'yes?' }]));
    expect(parseModelInferenceRequest({ ...body, questions: many }).ok).toBe(false);
  });

  it('refuses malformed questions', () => {
    expect(parseModelInferenceRequest({ ...body, questions: { a: { type: 'choice', instructions: 'pick', criteria: { only: null } } } }).ok).toBe(false);
    expect(parseModelInferenceRequest({ ...body, questions: [] }).ok).toBe(false);
    expect(parseModelInferenceRequest({ ...body, state: null }).ok).toBe(false);
  });
});
