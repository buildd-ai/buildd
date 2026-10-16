import { describe, expect, it } from 'bun:test';
import {
  DECISION_MODEL_KINDS,
  decisionModelFor,
  decisionModelKindLabel,
  isClefModel,
  isDecisionModelKind,
  isJevModel,
  normalizeDecisionModel,
  normalizeDecisionModelSetting,
  readDecisionModel,
  readDecisionModelOverrides,
  readDecisionModelSetting,
  withDecisionModelDefault,
  withDecisionModelForKind,
} from '../decision-model';

describe('normalizeDecisionModel', () => {
  it('null clears back to Jev', () => {
    expect(normalizeDecisionModel(null)).toEqual({ ok: true, value: null });
  });
  it('defaults to a chat model via OpenRouter', () => {
    expect(normalizeDecisionModel({ model: ' qwen/qwen3-8b ' })).toEqual({ ok: true, value: { endpoint: 'chat', model: 'qwen/qwen3-8b', via: 'openrouter' } });
  });
  it('accepts a chat model through the LiteLLM gateway', () => {
    expect(normalizeDecisionModel({ endpoint: 'chat', model: 'qwen3-8b', via: 'litellm' }).ok).toBe(true);
  });
  it('refuses a System One model through the gateway, unknown fields and bad ids', () => {
    expect(normalizeDecisionModel({ endpoint: 'systemone', model: 'typesafe/jev-1.13', via: 'litellm' }).ok).toBe(false);
    expect(normalizeDecisionModel({ endpoint: 'batch', model: 'm' }).ok).toBe(false);
    expect(normalizeDecisionModel({ model: 'has space' }).ok).toBe(false);
    expect(normalizeDecisionModel('qwen').ok).toBe(false);
  });
  it('reads a malformed stored value as the default', () => {
    expect(readDecisionModel({ endpoint: 'nope' })).toBeNull();
  });
});

describe('isJevModel', () => {
  it('knows versioned and pinned Jev ids, and nothing else', () => {
    expect(isJevModel('typesafe/jev-1.13')).toBe(true);
    expect(isJevModel('typesafe/jev-1.13-20260917')).toBe(true);
    expect(isJevModel('qwen3-8b')).toBe(false);
    expect(isJevModel(null)).toBe(false);
  });
});

describe('decision models through Cloudflare', () => {
  it('serves Clef as a System One model via Cloudflare, by default and normalised to its body id', () => {
    expect(normalizeDecisionModel({ model: 'clef' })).toEqual({ ok: true, value: { endpoint: 'systemone', model: 'clef', via: 'cloudflare' } });
    expect(normalizeDecisionModel({ endpoint: 'systemone', model: '@cf/cloudflare/clef-flash', via: 'cloudflare' }))
      .toEqual({ ok: true, value: { endpoint: 'systemone', model: 'clef-flash', via: 'cloudflare' } });
  });
  it('sends Jev through the AI Gateway', () => {
    expect(normalizeDecisionModel({ endpoint: 'systemone', model: 'typesafe/jev-1.13', via: 'cloudflare' }))
      .toEqual({ ok: true, value: { endpoint: 'systemone', model: 'typesafe/jev-1.13', via: 'cloudflare' } });
  });
  it('refuses Clef anywhere but Cloudflare, and anything but Jev or Clef via Cloudflare', () => {
    expect(normalizeDecisionModel({ endpoint: 'systemone', model: 'clef', via: 'openrouter' }).ok).toBe(false);
    expect(normalizeDecisionModel({ endpoint: 'chat', model: 'clef' }).ok).toBe(false);
    expect(normalizeDecisionModel({ endpoint: 'chat', model: 'qwen3-8b', via: 'cloudflare' }).ok).toBe(false);
    expect(normalizeDecisionModel({ endpoint: 'systemone', model: 'other/so-model', via: 'cloudflare' }).ok).toBe(false);
  });
  it('knows Clef ids', () => {
    expect(isClefModel('clef-flash')).toBe(true);
    expect(isClefModel('@cf/cloudflare/clef')).toBe(true);
    expect(isClefModel('typesafe/jev-1.13')).toBe(false);
  });
});

describe('per-decision overrides (byKind)', () => {
  const CLEF = { endpoint: 'systemone', model: 'clef', via: 'cloudflare' } as const;
  const QWEN = { endpoint: 'chat', model: 'qwen/qwen3-8b', via: 'openrouter' } as const;

  it('validates each override with the same rules as the team default', () => {
    expect(normalizeDecisionModelSetting({ ...QWEN, byKind: { 'buildd.orchestration_claim_hold': { model: 'clef' } } }))
      .toEqual({ ok: true, value: { ...QWEN, byKind: { 'buildd.orchestration_claim_hold': CLEF } } });
    const viaOpenRouter = normalizeDecisionModelSetting({ byKind: { task_category: { endpoint: 'systemone', model: 'clef', via: 'openrouter' } } });
    expect(viaOpenRouter.ok).toBe(false);
    if (!viaOpenRouter.ok) expect(viaOpenRouter.error).toContain('task_category');
    expect(normalizeDecisionModelSetting({ byKind: { task_category: { model: 'has space' } } }).ok).toBe(false);
    expect(normalizeDecisionModelSetting({ byKind: { task_category: 'clef' } }).ok).toBe(false);
    expect(normalizeDecisionModelSetting({ byKind: ['clef'] }).ok).toBe(false);
  });

  it('rejects an override for a decision it does not know', () => {
    const r = normalizeDecisionModelSetting({ byKind: { 'buildd.no_such_decision': { model: 'clef' } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('buildd.no_such_decision');
  });

  it('keeps overrides with no team default: the default stays Jev', () => {
    const r = normalizeDecisionModelSetting({ byKind: { task_role: { model: 'clef' } } });
    expect(r).toEqual({ ok: true, value: { byKind: { task_role: CLEF } } });
    expect(readDecisionModel(r.ok ? r.value : null)).toBeNull();
    expect(normalizeDecisionModelSetting({ byKind: {} })).toEqual({ ok: true, value: null });
  });

  it('a single route still needs a model', () => {
    expect(normalizeDecisionModel({ byKind: { task_role: { model: 'clef' } } }).ok).toBe(false);
  });

  it('the override beats the team default; no override is the team default', () => {
    const stored = { ...QWEN, byKind: { 'buildd.orchestration_claim_hold': CLEF } };
    expect(decisionModelFor(stored, 'buildd.orchestration_claim_hold')).toEqual(CLEF);
    expect(decisionModelFor(stored, 'task_category')).toEqual(QWEN);
    expect(decisionModelFor(stored)).toEqual(QWEN);
    expect(decisionModelFor(stored, 'buildd.not_a_kind')).toEqual(QWEN);
    expect(decisionModelFor({ byKind: { task_role: CLEF } }, 'task_category')).toBeNull();
    expect(decisionModelFor(null, 'task_role')).toBeNull();
  });

  it('reads the team default without its overrides', () => {
    expect(readDecisionModel({ ...QWEN, byKind: { task_role: CLEF } })).toEqual(QWEN);
    expect(readDecisionModelOverrides({ ...QWEN, byKind: { task_role: CLEF } })).toEqual({ task_role: CLEF });
  });

  it('reads a stored value defensively: a bad override is dropped, the rest kept', () => {
    const stored = { ...QWEN, byKind: { task_role: CLEF, task_category: { model: 'clef', via: 'openrouter' }, 'buildd.gone': CLEF } };
    expect(readDecisionModelSetting(stored)).toEqual({ ...QWEN, byKind: { task_role: CLEF } });
    expect(decisionModelFor(stored, 'task_category')).toEqual(QWEN);
    expect(decisionModelFor({ endpoint: 'nope', byKind: { task_role: CLEF } }, 'task_role')).toEqual(CLEF);
  });

  it('sets, replaces and clears one override, leaving the default and the others alone', () => {
    const one = withDecisionModelForKind(QWEN, 'task_role', CLEF);
    expect(one).toEqual({ ...QWEN, byKind: { task_role: CLEF } });
    const two = withDecisionModelForKind(one, 'task_category', QWEN);
    expect(two).toEqual({ ...QWEN, byKind: { task_role: CLEF, task_category: QWEN } });
    expect(withDecisionModelForKind(two, 'task_role', null)).toEqual({ ...QWEN, byKind: { task_category: QWEN } });
    expect(withDecisionModelForKind(withDecisionModelForKind(two, 'task_role', null), 'task_category', null)).toEqual(QWEN);
  });

  it('clearing the last override with no team default leaves nothing stored', () => {
    const only = withDecisionModelForKind(null, 'task_role', CLEF);
    expect(only).toEqual({ byKind: { task_role: CLEF } });
    expect(withDecisionModelForKind(only, 'task_role', null)).toBeNull();
    expect(withDecisionModelForKind(null, 'task_role', null)).toBeNull();
  });

  it('replacing the team default keeps the overrides', () => {
    const stored = { ...QWEN, byKind: { task_role: CLEF } };
    expect(withDecisionModelDefault(stored, null)).toEqual({ byKind: { task_role: CLEF } });
    expect(withDecisionModelDefault({ byKind: { task_role: CLEF } }, QWEN)).toEqual(stored);
    expect(withDecisionModelDefault(QWEN, null)).toBeNull();
  });

  it('labels every decision a team can override', () => {
    for (const kind of DECISION_MODEL_KINDS) expect(decisionModelKindLabel(kind).length).toBeGreaterThan(0);
    expect(decisionModelKindLabel('buildd.orchestration_claim_hold')).toBe('Start or wait');
    expect(isDecisionModelKind('task_category')).toBe(true);
    expect(isDecisionModelKind('buildd.no_such_decision')).toBe(false);
  });
});
