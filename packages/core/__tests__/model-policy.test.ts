/**
 * buildd on the standalone model policy (packages/core/model-policy.ts).
 *
 * Proves the policy is buildd's one tier authority: agent claims resolve as
 * `coding` and chat as `chat`, the registry is a policy document under the
 * kit's precedence, the remote service is the default layer (never over an
 * admin row) with a local fallback when it is down, shorthand pins are tier
 * requests while exact ids stay the escape hatch, and outcomes are typed and
 * only reported against a service-issued plan.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { PolicyClient, PolicyDecision, PolicyRequest, OutcomeReport } from '@builddai/ai-kit/policy';
import { DEFAULT_MODEL_POLICY, resolveModelPolicy } from '@builddai/ai-kit/policy';

const mockFindMany = mock();
mock.module('../db/client', () => ({ db: { query: { modelTierRegistry: { findMany: mockFindMany } } } }));
mock.module('../db/schema', () => ({ modelTierRegistry: { teamId: 'team_id', tier: 'tier', workspaceId: 'workspace_id' }, systemCache: {} }));
mock.module('drizzle-orm', () => ({
  eq: (a: unknown, b: unknown) => ({ type: 'eq', a, b }),
  and: (...args: unknown[]) => ({ type: 'and', args }),
  isNull: (col: unknown) => ({ type: 'isNull', col }),
}));
const mockCatalog = mock(() => Promise.resolve([] as unknown[]));
mock.module('../model-catalog-cache', () => ({ getCachedOpenRouterCatalog: mockCatalog }));

const { resolveTierEntry, invalidateTierCache, TIER_DEFAULTS, TIERS } = await import('../model-tier-registry');
const policy = await import('../model-policy');
const { shorthandPinTier } = await import('../model-pin');
const { resolveEffectiveModel } = await import('../model-router');
const { DEFAULT_ALIASES } = await import('../model-aliases');

const TEAM = 'team-1';
const WS = 'ws-1';
const row = (workspaceId: string | null, surface: 'agent' | 'chat' | null, model: string, tier = 'standard') => ({
  teamId: TEAM, workspaceId, surface, tier, provider: 'anthropic', model, defaultEffort: null, defaultMaxTurns: null,
});

/** A fake policy service: answers with `answer`, records every call. */
function fakeService(answer: (req: PolicyRequest) => PolicyDecision | Error) {
  const resolves: PolicyRequest[] = [];
  const outcomes: OutcomeReport[] = [];
  const client: PolicyClient = {
    async resolve(req) {
      resolves.push(req);
      const a = answer(req);
      if (a instanceof Error) throw a;
      return a;
    },
    async reportOutcome(report) { outcomes.push(report); return { ok: true }; },
  };
  return { client, resolves, outcomes };
}

const decision = (req: PolicyRequest, model: string, extra: Partial<PolicyDecision> = {}): PolicyDecision => ({
  provider: 'anthropic', model, effort: null, policyVersion: 'svc-7', planId: 'plan-1',
  surface: req.surface, tier: req.tier, source: 'tier', ...extra,
});

beforeEach(() => {
  mockFindMany.mockReset();
  mockCatalog.mockReset();
  mockCatalog.mockReturnValue(Promise.resolve([]));
  invalidateTierCache(TEAM);
  policy.setRemotePolicyClient(null);
});

describe('surface mapping: agent → coding, chat → chat', () => {
  it('a claim resolves on the coding surface and a chat call on the chat surface', async () => {
    mockFindMany.mockResolvedValue([]);
    const agent = await resolveTierEntry('standard', TEAM, WS, 'agent');
    const chat = await resolveTierEntry('standard', TEAM, WS, 'chat');
    expect(agent.policy?.surface).toBe('coding');
    expect(chat.policy?.surface).toBe('chat');
  });

  it('asks the service with surface coding for an agent claim, never agent', async () => {
    mockFindMany.mockResolvedValue([]);
    const svc = fakeService((req) => decision(req, 'svc-model'));
    policy.setRemotePolicyClient(svc.client);
    await resolveTierEntry('budget', TEAM, WS, 'agent');
    await resolveTierEntry('budget', TEAM, WS, 'chat');
    expect(svc.resolves.map((r) => r.surface)).toEqual(['coding', 'chat']);
    expect(svc.resolves[0]).toEqual({ surface: 'coding', tier: 'budget', app: 'buildd', workspaceId: WS });
  });
});

describe('chat and coding stay separate', () => {
  it('a split tier serves each surface its own row, and the shared view neither', async () => {
    mockFindMany.mockResolvedValue([row(null, 'agent', 'coding-model'), row(null, 'chat', 'chat-model')]);
    expect((await resolveTierEntry('standard', TEAM, WS, 'agent')).model).toBe('coding-model');
    expect((await resolveTierEntry('standard', TEAM, WS, 'chat')).model).toBe('chat-model');
    expect((await resolveTierEntry('standard', TEAM, WS, null)).source).toBe('default');
  });

  it('the registry document maps surface rows onto the protocol surfaces', () => {
    const { policy: doc } = policy.registryModelPolicy([row(null, 'agent', 'a'), row(null, 'chat', 'c'), row(null, null, 's')]);
    expect(doc.surfaces?.coding?.standard?.model).toBe('a');
    expect(doc.surfaces?.chat?.standard?.model).toBe('c');
    expect(doc.tiers.standard?.model).toBe('s');
    expect(Object.keys(doc.surfaces ?? {})).not.toContain('agent');
  });
});

describe('registry precedence is the policy resolver\'s', () => {
  const rows = [
    row(null, null, 'team'),
    row(null, 'agent', 'team+surface'),
    row(WS, null, 'workspace'),
    row(WS, 'agent', 'workspace+surface'),
  ];

  it('workspace+surface → workspace → team+surface → team', () => {
    const at = (rs: typeof rows, ws: string | null) => policy.resolveRegistryTier(rs, 'standard', ws, 'agent')?.row.model;
    expect(at(rows, WS)).toBe('workspace+surface');
    expect(at(rows.slice(0, 3), WS)).toBe('workspace');
    expect(at(rows, null)).toBe('team+surface');
    expect(at(rows.slice(0, 1), null)).toBe('team');
  });

  it('the kit resolver, given the registry document, picks the same model buildd serves', async () => {
    mockFindMany.mockResolvedValue(rows);
    const { policy: doc } = policy.registryModelPolicy(rows);
    for (const ws of [WS, 'other', undefined]) {
      const kit = resolveModelPolicy(doc, { surface: 'coding', tier: 'standard', ...(ws ? { workspaceId: ws } : {}) });
      const served = await resolveTierEntry('standard', TEAM, ws ?? null, 'agent');
      expect(served.model).toBe(kit.model);
    }
  });

  it('a registry decision carries its document version and source, with no planId', async () => {
    mockFindMany.mockResolvedValue(rows);
    const entry = await resolveTierEntry('standard', TEAM, WS, 'agent');
    expect(entry.source).toBe('workspace');
    expect(entry.policy).toMatchObject({ source: 'override', planId: null, surface: 'coding' });
    expect(entry.policy?.version).toMatch(/^buildd-registry@/);
  });

  it('the document version changes when a row does', () => {
    const v1 = policy.registryPolicyVersion([row(null, null, 'a')]);
    const v2 = policy.registryPolicyVersion([row(null, null, 'b')]);
    expect(v1).not.toBe(v2);
    expect(policy.registryPolicyVersion([row(null, null, 'a')])).toBe(v1);
  });
});

describe('remote policy and fallback', () => {
  it('an admin registry row wins over the service', async () => {
    mockFindMany.mockResolvedValue([row(null, null, 'admin-pick')]);
    const svc = fakeService((req) => decision(req, 'svc-model'));
    policy.setRemotePolicyClient(svc.client);
    expect((await resolveTierEntry('standard', TEAM, WS, 'agent')).model).toBe('admin-pick');
    expect(svc.resolves).toHaveLength(0);
  });

  it('the service answers for a tier the registry leaves unset, with its planId and experiment', async () => {
    mockFindMany.mockResolvedValue([]);
    const svc = fakeService((req) => decision(req, 'svc-model', {
      source: 'experiment', experiment: { key: 'e1', mode: 'split', arm: 'b' },
    }));
    policy.setRemotePolicyClient(svc.client);
    const entry = await resolveTierEntry('premium', TEAM, WS, 'agent');
    expect(entry).toMatchObject({ model: 'svc-model', source: 'policy' });
    expect(entry.policy).toMatchObject({ version: 'svc-7', planId: 'plan-1', source: 'experiment', experiment: { key: 'e1', arm: 'b' } });
  });

  it('a service outage falls back to the bundled policy, and cools down instead of retrying every call', async () => {
    mockFindMany.mockResolvedValue([]);
    let calls = 0;
    const failing = (async () => { calls++; return new Response('nope', { status: 503 }); }) as unknown as typeof fetch;
    policy.setRemotePolicyClient(policy.buildRemotePolicyClient({ endpoint: 'https://policy.example', token: 't'.repeat(32) }, failing));
    const first = await resolveTierEntry('premium', TEAM, WS, 'agent');
    expect(first.model).toBe(DEFAULT_MODEL_POLICY.tiers.premium.model);
    expect(first.source).toBe('default');
    await resolveTierEntry('budget', TEAM, WS, 'agent');
    expect(calls).toBe(1);
  });

  it('every resolve is its own plan; during an outage the last good answer serves, with no planId', async () => {
    mockFindMany.mockResolvedValue([]);
    let n = 0;
    let up = true;
    const svc = fakeService((req) => (up ? decision(req, 'svc-model', { planId: `plan-${++n}` }) : new Error('down')));
    policy.setRemotePolicyClient(svc.client);
    const a = await resolveTierEntry('premium', TEAM, WS, 'agent');
    const b = await resolveTierEntry('premium', TEAM, WS, 'agent');
    expect([a.policy?.planId, b.policy?.planId]).toEqual(['plan-1', 'plan-2']);
    up = false;
    const c = await resolveTierEntry('premium', TEAM, WS, 'agent');
    expect(c.model).toBe('svc-model');
    expect(c.policy).toMatchObject({ source: 'cached', planId: null });
  });

  it('a thrown client error is absorbed', async () => {
    mockFindMany.mockResolvedValue([]);
    policy.setRemotePolicyClient(fakeService(() => new Error('down')).client);
    expect((await resolveTierEntry('premium', TEAM, WS, 'agent')).source).toBe('default');
  });

  it('the service decision goes through the kit client: a credential-shaped answer is refused', async () => {
    mockFindMany.mockResolvedValue([]);
    const leaky = (async (_url: string, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body));
      return Response.json({ ...decision(req, 'svc-model'), apiKey: 'sk-ant-xxx' });
    }) as unknown as typeof fetch;
    policy.setRemotePolicyClient(policy.buildRemotePolicyClient({ endpoint: 'https://policy.example', token: 't'.repeat(32) }, leaky));
    const entry = await resolveTierEntry('standard', TEAM, WS, 'agent');
    expect(entry.model).toBe(TIER_DEFAULTS.standard.model);
  });

  it('a service fallback/bundled answer is not authoritative: buildd\'s catalog and bundled layers still apply', async () => {
    mockFindMany.mockResolvedValue([]);
    const svc = fakeService((req) => decision(req, 'svc-guess', { source: 'fallback', planId: null }));
    policy.setRemotePolicyClient(svc.client);
    const entry = await resolveTierEntry('budget', TEAM, WS, 'chat');
    expect(entry.model).toBe(TIER_DEFAULTS.budget.model);
    expect(entry.policy).toMatchObject({ version: 'bundled', source: 'bundled', surface: 'chat' });
  });

  it('a DB outage still resolves through the default layer', async () => {
    mockFindMany.mockRejectedValue(new Error('db down'));
    const svc = fakeService((req) => decision(req, 'svc-model'));
    policy.setRemotePolicyClient(svc.client);
    expect((await resolveTierEntry('standard', TEAM, WS, 'agent')).model).toBe('svc-model');
  });

  it('no team still resolves (no registry, default layer only)', async () => {
    const entry = await resolveTierEntry('standard', null, null, 'agent');
    expect(entry.model).toBe(TIER_DEFAULTS.standard.model);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('remote config needs both env vars, and refuses a provider key as the token', () => {
    expect(policy.remotePolicyConfigFromEnv({})).toBeNull();
    expect(policy.remotePolicyConfigFromEnv({ BUILDD_MODEL_POLICY_URL: 'https://p.example' })).toBeNull();
    expect(policy.remotePolicyConfigFromEnv({ BUILDD_MODEL_POLICY_URL: 'https://p.example', BUILDD_MODEL_POLICY_TOKEN: 't'.repeat(32) }))
      .toEqual({ endpoint: 'https://p.example', token: 't'.repeat(32) });
  });
});

describe('the bundled default is the policy\'s, not a second table', () => {
  it('TIER_DEFAULTS is the kit\'s DEFAULT_MODEL_POLICY', () => {
    for (const t of TIERS) {
      expect({ provider: TIER_DEFAULTS[t].provider, model: TIER_DEFAULTS[t].model }).toEqual(DEFAULT_MODEL_POLICY.tiers[t]);
    }
  });

  it('the shorthand alias map names the tiers it stands for', () => {
    expect(DEFAULT_ALIASES.opus).toBe(TIER_DEFAULTS.premium.model);
    expect(DEFAULT_ALIASES.sonnet).toBe(TIER_DEFAULTS.standard.model);
    expect(DEFAULT_ALIASES.haiku).toBe(TIER_DEFAULTS.budget.model);
  });
});

describe('explicit pins', () => {
  it('a shorthand pin is a tier request, resolved by the policy', () => {
    expect(shorthandPinTier('opus')).toBe('premium');
    expect(shorthandPinTier('sonnet')).toBe('standard');
    expect(shorthandPinTier('haiku')).toBe('budget');
  });

  it('an exact model id is the escape hatch: no tier, and the router passes it through untouched', () => {
    expect(shorthandPinTier('claude-custom-pin-1')).toBeNull();
    expect(shorthandPinTier(null)).toBeNull();
    const d = resolveEffectiveModel({ explicitModel: 'claude-custom-pin-1' });
    expect(d).toMatchObject({ model: 'claude-custom-pin-1', reason: 'explicit_override' });
  });
});

describe('outcomes', () => {
  const ctx = (planId: string | null, surface: 'coding' | 'chat' = 'coding') => ({
    resolvedTier: { tier: 'standard', provider: 'anthropic', policy: { version: 'svc-7', planId, source: 'tier', surface } },
  });

  it('reports typed coding observations against a service-issued plan', async () => {
    const svc = fakeService((req) => decision(req, 'm'));
    policy.setRemotePolicyClient(svc.client);
    const r = await policy.reportPolicyOutcome(ctx('plan-9'), [{ type: 'tests', passed: true }, { type: 'merged', merged: true }]);
    expect(r.reported).toBe(true);
    expect(svc.outcomes).toEqual([{ planId: 'plan-9', surface: 'coding', observations: [{ type: 'tests', passed: true }, { type: 'merged', merged: true }] }]);
  });

  it('reports nothing for a local/registry decision (no planId) or with no service', async () => {
    const svc = fakeService((req) => decision(req, 'm'));
    policy.setRemotePolicyClient(svc.client);
    expect((await policy.reportPolicyOutcome(ctx(null), [{ type: 'tests', passed: true }])).reported).toBe(false);
    expect((await policy.reportPolicyOutcome({}, [{ type: 'tests', passed: true }])).reported).toBe(false);
    policy.setRemotePolicyClient(null);
    expect((await policy.reportPolicyOutcome(ctx('plan-9'), [{ type: 'tests', passed: true }])).reported).toBe(false);
    expect(svc.outcomes).toHaveLength(0);
  });

  it('run observations carry only what was measured, and no score', () => {
    expect(policy.codingRunObservations({ durationMs: 1234.4, costUsd: '0.52' })).toEqual([
      { type: 'duration', ms: 1234 }, { type: 'cost', usd: 0.52 },
    ]);
    expect(policy.codingRunObservations({ durationMs: null, costUsd: null })).toEqual([]);
    for (const o of policy.codingRunObservations({ durationMs: 1, costUsd: 1, goalCriteriaPassed: true })) {
      expect(Object.keys(o)).not.toContain('score');
    }
  });

  it('a review verdict maps to the verdict plus rework', () => {
    expect(policy.reviewVerdictObservations('request-changes')).toEqual([
      { type: 'review_verdict', verdict: 'request_changes' }, { type: 'rework', required: true },
    ]);
    expect(policy.reviewVerdictObservations('approve')[0]).toEqual({ type: 'review_verdict', verdict: 'approve' });
    expect(policy.reviewVerdictObservations('escalate')).toEqual([{ type: 'review_verdict', verdict: 'escalate' }]);
  });
});
