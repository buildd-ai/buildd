import { describe, test, expect } from 'bun:test';
import {
  getModelDisplayName,
  primaryModelFromUsage,
  compareAssignedActual,
} from '../model-display';

/**
 * Four independent humanisers existed before this module, and one was wrong:
 * `team/[slug]/page.tsx` mapped the alias `opus` to the literal string
 * "Claude Opus 4", so it mislabelled the premium model by two generations.
 * These tests pin the one implementation the rest now share.
 */
describe('getModelDisplayName', () => {
  test('names the current generation', () => {
    expect(getModelDisplayName('claude-opus-5')).toBe('Opus 5');
    expect(getModelDisplayName('claude-sonnet-5')).toBe('Sonnet 5');
    expect(getModelDisplayName('claude-fable-5')).toBe('Fable 5');
  });

  test('renders a dotted minor version, not a hyphen', () => {
    expect(getModelDisplayName('claude-sonnet-4-6')).toBe('Sonnet 4.6');
    expect(getModelDisplayName('claude-opus-4-8')).toBe('Opus 4.8');
  });

  test('drops a dated snapshot suffix', () => {
    expect(getModelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(getModelDisplayName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
  });

  test('humanises a bare tier alias', () => {
    expect(getModelDisplayName('sonnet')).toBe('Sonnet');
    expect(getModelDisplayName('opus')).toBe('Opus');
  });

  test('never invents a version number for an alias', () => {
    // The bug this module replaces: `opus` -> "Claude Opus 4". An alias names a
    // family, not a release, so appending a version is a guess that goes stale.
    expect(getModelDisplayName('opus')).not.toContain('4');
    expect(getModelDisplayName('opus')).not.toContain('5');
  });

  test('passes through a non-Anthropic id rather than mangling it', () => {
    expect(getModelDisplayName('codex')).toBe('Codex');
    expect(getModelDisplayName('gpt-5-codex')).toBe('gpt-5-codex');
  });

  test('is total — empty and unparseable inputs do not throw', () => {
    expect(getModelDisplayName('')).toBe('');
    expect(getModelDisplayName('nonsense')).toBe('nonsense');
  });
});

/**
 * A worker can report several models: a fallback firing is a real feature. So
 * "the model it ran on" is not always singular, and the UI must not silently
 * pick an arbitrary key.
 */
describe('primaryModelFromUsage', () => {
  const usage = (m: Record<string, { inputTokens?: number; outputTokens?: number }>) => m;

  test('picks the model with the most tokens', () => {
    const r = primaryModelFromUsage(usage({
      'claude-sonnet-5': { inputTokens: 100, outputTokens: 50 },
      'claude-haiku-4-5-20251001': { inputTokens: 10, outputTokens: 5 },
    }));
    expect(r.primary).toBe('claude-sonnet-5');
    expect(r.all).toEqual(['claude-sonnet-5', 'claude-haiku-4-5-20251001']);
    expect(r.multiple).toBe(true);
  });

  test('reports a single model as not multiple', () => {
    const r = primaryModelFromUsage(usage({ 'claude-opus-5': { inputTokens: 9 } }));
    expect(r.primary).toBe('claude-opus-5');
    expect(r.multiple).toBe(false);
  });

  test('empty usage yields no primary — seat/OAuth auth reports nothing', () => {
    // Must be null, never a zero or an empty string masquerading as a model.
    expect(primaryModelFromUsage({}).primary).toBeNull();
    expect(primaryModelFromUsage(null).primary).toBeNull();
    expect(primaryModelFromUsage(undefined).primary).toBeNull();
  });
});

/**
 * Divergence is the point of the feature, so a false positive is worse than no
 * metric. `predicted_model` is polymorphic: a full id normally, a bare alias
 * when the task has no team.
 */
describe('compareAssignedActual', () => {
  test('identical ids agree', () => {
    expect(compareAssignedActual('claude-sonnet-5', 'claude-sonnet-5').verdict).toBe('agree');
  });

  test('an alias agrees with any release in its family', () => {
    // The false-positive trap: comparing `sonnet` to `claude-sonnet-5` as
    // strings reports divergence for every team-less task.
    expect(compareAssignedActual('sonnet', 'claude-sonnet-5').verdict).toBe('agree');
    expect(compareAssignedActual('opus', 'claude-opus-5').verdict).toBe('agree');
  });

  test('an alias against a different family diverges', () => {
    expect(compareAssignedActual('sonnet', 'claude-opus-5').verdict).toBe('diverged');
  });

  test('two releases of the same family diverge — a version gap is real', () => {
    // Same family is NOT enough: running 4.6 when 5 was assigned is the exact
    // drift that cost 50% per token.
    const r = compareAssignedActual('claude-sonnet-5', 'claude-sonnet-4-6');
    expect(r.verdict).toBe('diverged');
  });

  test('a dated snapshot agrees with its undated id', () => {
    expect(compareAssignedActual('claude-haiku-4-5', 'claude-haiku-4-5-20251001').verdict).toBe('agree');
  });

  test('missing actual is unattributed, never agreement', () => {
    // Counting "no data" as agreement is how a divergence rate reads 0% and
    // means "never recorded".
    expect(compareAssignedActual('claude-sonnet-5', null).verdict).toBe('unattributed');
    expect(compareAssignedActual('claude-sonnet-5', '').verdict).toBe('unattributed');
  });

  test('missing assigned is unattributed', () => {
    expect(compareAssignedActual(null, 'claude-sonnet-5').verdict).toBe('unattributed');
  });

  test('a non-Anthropic actual is unattributed, not diverged', () => {
    // Codex reports the literal string `codex`, which names no model. Calling
    // that a divergence would flag every Codex task forever.
    expect(compareAssignedActual('claude-sonnet-5', 'codex').verdict).toBe('unattributed');
  });
});
