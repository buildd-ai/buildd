import { describe, expect, it } from 'bun:test';
import { DEFAULT_MODEL_POLICY } from './defaults';
import {
  findCredentialLike, parseOutcomeReport, parsePolicyDecision, parsePolicyRequest, toBuilddSurface,
  toPolicySurface, validateModelPolicy,
} from './protocol';

describe('the public request stays surface + tier', () => {
  it('accepts exactly surface, tier, app, workspaceId', () => {
    expect(parsePolicyRequest({ surface: 'chat', tier: 'standard', app: 'cue', workspaceId: 'ws1' }))
      .toEqual({ ok: true, value: { surface: 'chat', tier: 'standard', app: 'cue', workspaceId: 'ws1' } });
    expect(parsePolicyRequest({ surface: 'coding', tier: 'budget' })).toEqual({ ok: true, value: { surface: 'coding', tier: 'budget' } });
  });

  it.each(['intent', 'workload', 'kind', 'model', 'provider', 'messages', 'prompt', 'apiKey'])('refuses a caller-declared %s', (field) => {
    const r = parsePolicyRequest({ surface: 'chat', tier: 'standard', [field]: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(field);
  });

  it("names 'coding' when a caller sends buildd's 'agent'", () => {
    const r = parsePolicyRequest({ surface: 'agent', tier: 'standard' });
    expect(r).toEqual({ ok: false, error: "request: surface 'agent' is 'coding' in this protocol" });
  });

  it('refuses unknown tiers, including renamed premium-plus', () => {
    expect(parsePolicyRequest({ surface: 'chat', tier: 'deep' }).ok).toBe(false);
    expect(parsePolicyRequest({ surface: 'chat', tier: 'premium_plus' }).ok).toBe(false);
    expect(parsePolicyRequest({ surface: 'chat', tier: 'premium-plus' }).ok).toBe(true);
  });
});

describe('surface mapping at the boundary', () => {
  it("buildd's agent is coding; chat and inference are chat", () => {
    expect(toPolicySurface('agent')).toBe('coding');
    expect(toPolicySurface('chat')).toBe('chat');
    expect(toPolicySurface('inference')).toBe('chat');
    expect(toPolicySurface('coding')).toBe('coding');
    expect(toBuilddSurface('coding')).toBe('agent');
    expect(toBuilddSurface('chat')).toBe('chat');
  });
});

describe('validateModelPolicy', () => {
  it('accepts the bundled policy', () => {
    expect(validateModelPolicy(DEFAULT_MODEL_POLICY).ok).toBe(true);
  });

  it('reports every problem at once', () => {
    const v = validateModelPolicy({
      version: '',
      tiers: { standard: { provider: 'bedrock', model: 'x' }, deep: { provider: 'anthropic', model: 'y' } },
      surfaces: { agent: {} },
      overrides: [{ match: {}, tier: 'standard', route: { provider: 'anthropic', model: 'z' } }],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.errors.join('\n')).toContain('policy.version');
      expect(v.errors.join('\n')).toContain('policy.tiers.standard.provider');
      expect(v.errors.join('\n')).toContain('unknown tier deep');
      expect(v.errors.join('\n')).toContain("'agent' is 'coding'");
      expect(v.errors.join('\n')).toContain('name an app, a workspaceId, or both');
    }
  });

  it('refuses a route carrying a credential', () => {
    const v = validateModelPolicy({ version: '1', tiers: { standard: { provider: 'anthropic', model: 'm', apiKey: 'sk-ant-xyz' } } });
    expect(v.ok).toBe(false);
  });

  describe('experiments without signal', () => {
    const arms = [{ name: 'a', route: { provider: 'anthropic', model: 'a' } }, { name: 'b', route: { provider: 'anthropic', model: 'b' } }];
    const doc = (e: Record<string, unknown>) => ({ version: '1', tiers: {}, experiments: [{ key: 'e', tier: 'standard', arms, ...e }] });

    it('split and shadow need no signal', () => {
      expect(validateModelPolicy(doc({ mode: 'split' })).ok).toBe(true);
      expect(validateModelPolicy(doc({ mode: 'shadow', arms: [arms[0]] })).ok).toBe(true);
    });

    it('adaptive with no signal is refused', () => {
      const v = validateModelPolicy(doc({ mode: 'adaptive', surface: 'coding' }));
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.errors[0]).toContain('use split or shadow');
    });

    it('adaptive on chat is refused: chat has no trustworthy signal yet', () => {
      for (const signal of ['explicit_feedback', 'regenerated', 'latency', 'cost']) {
        const v = validateModelPolicy(doc({ mode: 'adaptive', surface: 'chat', signal }));
        expect(v.ok).toBe(false);
      }
    });

    it('adaptive on coding with a strong outcome signal is allowed; cost alone is not a quality signal', () => {
      expect(validateModelPolicy(doc({ mode: 'adaptive', surface: 'coding', signal: 'tests' })).ok).toBe(true);
      expect(validateModelPolicy(doc({ mode: 'adaptive', surface: 'coding', signal: 'cost' })).ok).toBe(false);
    });

    it('adaptive must name a surface', () => {
      expect(validateModelPolicy(doc({ mode: 'adaptive', signal: 'tests' })).ok).toBe(false);
    });

    it('pinned/shadow take one arm, split two or more; shadow cannot name an arm control', () => {
      expect(validateModelPolicy(doc({ mode: 'pinned' })).ok).toBe(false);
      expect(validateModelPolicy(doc({ mode: 'split', arms: [arms[0]] })).ok).toBe(false);
      expect(validateModelPolicy(doc({ mode: 'shadow', arms: [{ ...arms[0], name: 'control' }] })).ok).toBe(false);
    });
  });
});

describe('typed outcomes, no generic score', () => {
  it('accepts typed coding and chat observations', () => {
    expect(parseOutcomeReport({ planId: 'p1', surface: 'coding', observations: [
      { type: 'tests', passed: true }, { type: 'review_verdict', verdict: 'approve' }, { type: 'merged', merged: true },
      { type: 'rework', required: false }, { type: 'duration', ms: 1200 }, { type: 'cost', usd: 0.4 },
    ] }).ok).toBe(true);
    expect(parseOutcomeReport({ planId: 'p1', surface: 'chat', observations: [
      { type: 'explicit_feedback', value: 'down' }, { type: 'regenerated' }, { type: 'evaluator', source: 'human', verdict: 'pass' },
    ] }).ok).toBe(true);
  });

  it('refuses a qualityScore, in any position', () => {
    expect(parseOutcomeReport({ planId: 'p1', surface: 'chat', observations: [{ type: 'quality', score: 0.8 }] }).ok).toBe(false);
    expect(parseOutcomeReport({ planId: 'p1', surface: 'chat', qualityScore: 0.8, observations: [{ type: 'regenerated' }] }).ok).toBe(false);
    expect(parseOutcomeReport({ planId: 'p1', surface: 'chat', observations: [{ type: 'regenerated', score: 1 }] }).ok).toBe(false);
  });

  it('refuses coding-only observations on chat', () => {
    const r = parseOutcomeReport({ planId: 'p1', surface: 'chat', observations: [{ type: 'merged', merged: true }] });
    expect(r).toEqual({ ok: false, error: 'outcome.observations[0]: merged is a coding observation' });
  });

  it('refuses malformed values', () => {
    expect(parseOutcomeReport({ planId: 'p1', surface: 'coding', observations: [{ type: 'tests', passed: 'yes' }] }).ok).toBe(false);
    expect(parseOutcomeReport({ planId: 'p1', surface: 'coding', observations: [{ type: 'latency', ms: -1 }] }).ok).toBe(false);
    expect(parseOutcomeReport({ planId: 'p1', surface: 'coding', observations: [] }).ok).toBe(false);
  });
});

describe('credential boundary', () => {
  const good = { provider: 'openrouter', model: 'anthropic/claude-sonnet-5', effort: 'medium', policyVersion: '42', planId: 'p1', surface: 'chat', tier: 'standard', source: 'tier' };

  it('a decision is rebuilt from known fields only', () => {
    const r = parsePolicyDecision({ ...good, internalNote: 'x', routingFeatures: { intent: 'research' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.value).sort()).toEqual(['effort', 'model', 'planId', 'policyVersion', 'provider', 'source', 'surface', 'tier']);
  });

  it.each([
    ['a top-level apiKey', { apiKey: 'abc' }],
    ['a nested provider secret', { credentials: { openrouter: 'x' } }],
    ['an authorization header echo', { headers: { Authorization: 'Bearer x' } }],
    ['a provider-key-shaped value', { note: 'sk-or-v1-abc' }],
    ['a key in the experiment block', { experiment: { key: 'e', mode: 'split', arm: 'a', token: 't' } }],
  ])('refuses a decision carrying %s', (_, extra) => {
    const r = parsePolicyDecision({ ...good, ...extra });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('credential');
  });

  it('findCredentialLike names the path', () => {
    expect(findCredentialLike({ a: [{ b: { client_secret: 1 } }] })).toBe('$.a[0].b.client_secret');
    expect(findCredentialLike({ model: 'claude-sonnet-5', refresh_token: undefined })).toBe('$.refresh_token');
    expect(findCredentialLike(good)).toBeNull();
  });
});
