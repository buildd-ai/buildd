import { describe, expect, test } from 'bun:test';
import {
  enforceTierCeiling,
  explainTierCeiling,
  parseSurfaceCeilings,
  resolveTierCeiling,
  type CeilingInputs,
} from '@buildd/shared';
import { bandExceedsLabel, claimTierRequest, enforceModelCeiling, modelSpendBand } from '../model-tier-ceiling';
import type { CatalogEntry } from '../model-catalog';

const WS = 'ws-1';
const OTHER_WS = 'ws-2';
const USER = 'user-1';

function entry(id: string, input: number, provider: CatalogEntry['provider'] = 'anthropic', orPrefix = 'anthropic'): CatalogEntry {
  return {
    id, canonicalId: null, openRouterId: `${orPrefix}/${id}`, provider, displayName: id,
    contextLength: 400_000, created: 1, input, output: input * 5, cacheRead: 0, cacheWrite: 0,
  };
}

const CATALOG: CatalogEntry[] = [
  entry('claude-haiku-4-5', 1),
  entry('claude-sonnet-5', 2),
  entry('claude-opus-5', 5),
  entry('claude-fable-5-1', 10),
  entry('gpt-5-mini', 0.25, 'openai', 'openai'),
  entry('gpt-5.3', 2.5, 'openai', 'openai'),
  entry('gpt-5.3-pro', 15, 'openai', 'openai'),
];

describe('resolveTierCeiling — precedence', () => {
  test('no layers → no ceiling, nothing changes', () => {
    const c = resolveTierCeiling({}, 'agent');
    expect(c.max).toBeNull();
    expect(enforceTierCeiling({ ceiling: c, tier: 'premium-plus', origin: 'task_tier' })).toEqual({ ok: true, tier: 'premium-plus' });
  });

  test('team premium cap denies an explicit premium-plus task', () => {
    const c = resolveTierCeiling({ team: { team: { all: 'premium' } } }, 'agent');
    const v = enforceTierCeiling({ ceiling: c, tier: 'premium-plus', origin: 'task_tier' });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.denied.error).toBe('policy_denied');
    expect(v.denied.code).toBe('tier_above_ceiling');
    expect(v.denied.maxTier).toBe('premium');
    expect(v.denied.binding.source).toBe('team');
    expect(v.denied.remedy).toContain('team admin');
  });

  test('most restrictive layer wins across team, workspace, admin member, self', () => {
    const inputs: CeilingInputs = {
      team: { team: { all: 'premium' }, workspaces: { [WS]: { all: 'standard' } } },
      workspaceId: WS,
      userId: USER,
      member: { admin: { agent: 'premium' }, self: { all: 'budget' } },
    };
    const c = resolveTierCeiling(inputs, 'agent');
    expect(c.max).toBe('budget');
    expect(c.binding?.source).toBe('member_self');
    expect(c.layers.map((l) => l.source)).toEqual(['team', 'workspace', 'member_admin', 'member_self']);
  });

  test('personal standard cap holds for that person', () => {
    const c = resolveTierCeiling({ userId: USER, member: { self: { all: 'standard' } } }, 'chat');
    const v = enforceTierCeiling({ ceiling: c, tier: 'premium', origin: 'chat_pin' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.denied.remedy).toContain('personal maximum');
  });

  test('member cannot raise an admin member cap with a higher self cap', () => {
    const c = resolveTierCeiling({ userId: USER, member: { admin: { all: 'standard' }, self: { all: 'premium-plus' } } }, 'agent');
    expect(c.max).toBe('standard');
    expect(c.binding?.source).toBe('member_admin');
  });

  test('workspace cap only applies to that workspace', () => {
    const team = { workspaces: { [WS]: { all: 'budget' as const } } };
    expect(resolveTierCeiling({ team, workspaceId: WS }, 'agent').max).toBe('budget');
    expect(resolveTierCeiling({ team, workspaceId: OTHER_WS }, 'agent').max).toBeNull();
  });

  test('surface caps narrow only their surface', () => {
    const team = { team: { all: 'premium' as const, chat: 'standard' as const } };
    expect(resolveTierCeiling({ team }, 'agent').max).toBe('premium');
    expect(resolveTierCeiling({ team }, 'chat').max).toBe('standard');
  });

  test('unidentified requester: member layers are not applied, and the explanation says so', () => {
    const inputs: CeilingInputs = { team: { team: { all: 'premium' } }, userId: null, member: { self: { all: 'budget' } } };
    const c = resolveTierCeiling(inputs, 'agent');
    expect(c.identified).toBe(false);
    expect(c.max).toBe('premium');
    expect(explainTierCeiling(c)).toContain('need a known person');
  });
});

describe('enforceTierCeiling — explicit vs auto', () => {
  const ceiling = resolveTierCeiling({ team: { team: { all: 'standard' } } }, 'agent');

  test('auto tier above the cap downgrades by default, never escalates', () => {
    expect(enforceTierCeiling({ ceiling, tier: 'premium', origin: 'auto' })).toEqual({ ok: true, tier: 'standard', downgradedFrom: 'premium' });
    expect(enforceTierCeiling({ ceiling, tier: 'budget', origin: 'auto' })).toEqual({ ok: true, tier: 'budget' });
  });

  test("auto tier is denied when the team chose overCapAuto 'deny'", () => {
    const strict = resolveTierCeiling({ team: { team: { all: 'standard' }, overCapAuto: 'deny' } }, 'agent');
    expect(enforceTierCeiling({ ceiling: strict, tier: 'premium', origin: 'auto' }).ok).toBe(false);
  });

  test.each(['task_tier', 'model_pin', 'role_model', 'chat_pin', 'request_tier'] as const)('explicit %s is never downgraded', (origin) => {
    expect(enforceTierCeiling({ ceiling, tier: 'premium', origin }).ok).toBe(false);
  });
});

describe('modelSpendBand — provider-independent', () => {
  test('bands Anthropic and OpenAI models by catalog price', () => {
    expect(modelSpendBand('claude-haiku-4-5', CATALOG)).toBe('budget');
    expect(modelSpendBand('claude-sonnet-5', CATALOG)).toBe('standard');
    expect(modelSpendBand('anthropic/claude-opus-5', CATALOG)).toBe('premium');
    expect(modelSpendBand('claude-fable-5-1[1m]', CATALOG)).toBe('premium-plus');
    expect(modelSpendBand('gpt-5-mini', CATALOG)).toBe('budget');
    expect(modelSpendBand('openai/gpt-5.3', CATALOG)).toBe('standard');
    expect(modelSpendBand('gpt-5.3-pro', CATALOG)).toBe('premium-plus');
  });

  test('no catalog: Claude falls back to family, others are unknown', () => {
    expect(modelSpendBand('claude-opus-9', [])).toBe('premium');
    expect(modelSpendBand('claude-fable-9', [])).toBe('premium-plus');
    expect(modelSpendBand('gpt-9', [])).toBeNull();
  });
});

describe('enforceModelCeiling — exact pins and re-maps', () => {
  const ceiling = resolveTierCeiling({ team: { team: { all: 'premium' } } }, 'agent');

  test('exact-id pin of a premium-plus model is denied under a premium cap', () => {
    const v = enforceModelCeiling({ ceiling, model: 'claude-fable-5-1', origin: 'model_pin', catalog: CATALOG });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.denied.code).toBe('model_above_ceiling');
      expect(v.denied.requested.model).toBe('claude-fable-5-1');
    }
  });

  test('an OpenAI model priced over the cap is denied the same way', () => {
    expect(enforceModelCeiling({ ceiling, model: 'gpt-5.3-pro', origin: 'auto', catalog: CATALOG }).ok).toBe(false);
    expect(enforceModelCeiling({ ceiling, model: 'gpt-5.3', origin: 'auto', catalog: CATALOG }).ok).toBe(true);
  });

  test('an unpriced model passes with unknownBand so the caller can warn', () => {
    const v = enforceModelCeiling({ ceiling, model: 'mystery-model', origin: 'auto', catalog: CATALOG });
    expect(v).toMatchObject({ ok: true, unknownBand: true });
  });

  test('bandExceedsLabel flags a standard label backed by an opus-priced model', () => {
    expect(bandExceedsLabel('claude-opus-5', 'standard', CATALOG)).toBe('premium');
    expect(bandExceedsLabel('claude-sonnet-5', 'standard', CATALOG)).toBeNull();
  });
});

describe('claimTierRequest — who asked for the tier', () => {
  const base = { pin: null, exactModel: null, pinTier: null, taskTier: null, roleTierOverride: null, roleFloor: null, routerTier: 'standard' as const };

  test('exact caller pin vs exact role id', () => {
    expect(claimTierRequest({ ...base, pin: 'claude-fable-5-1', exactModel: 'claude-fable-5-1' })).toEqual({ kind: 'model', model: 'claude-fable-5-1', origin: 'model_pin' });
    expect(claimTierRequest({ ...base, exactModel: 'claude-opus-5' })).toEqual({ kind: 'model', model: 'claude-opus-5', origin: 'role_model' });
  });

  test('shorthand pin, task tier and premium-plus role are explicit', () => {
    expect(claimTierRequest({ ...base, pin: 'opus', pinTier: 'premium' }).origin).toBe('model_pin');
    expect(claimTierRequest({ ...base, taskTier: 'premium-plus' }).origin).toBe('task_tier');
    expect(claimTierRequest({ ...base, roleTierOverride: 'premium-plus' }).origin).toBe('role_model');
  });

  test('router tier is auto unless the role floor put it there', () => {
    expect(claimTierRequest({ ...base, routerTier: 'premium' }).origin).toBe('auto');
    expect(claimTierRequest({ ...base, routerTier: 'premium', roleFloor: 'premium' }).origin).toBe('role_model');
    expect(claimTierRequest({ ...base, routerTier: 'premium', roleFloor: 'standard' }).origin).toBe('auto');
  });
});

describe('parseSurfaceCeilings', () => {
  test('rejects unknown keys and tiers rather than saving "no ceiling"', () => {
    expect(parseSurfaceCeilings({ all: 'premum' }).ok).toBe(false);
    expect(parseSurfaceCeilings({ coding: 'premium' }).ok).toBe(false);
    expect(parseSurfaceCeilings({ all: 'premium', chat: null })).toEqual({ ok: true, value: { all: 'premium' } });
  });
});
