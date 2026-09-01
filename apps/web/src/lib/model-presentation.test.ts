import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { deriveTaskModel, roleModelLabel } from './model-presentation';

const WEB_SRC = join(import.meta.dir, '..');

/**
 * The bug this replaces: `team/[slug]/page.tsx` mapped the alias `opus` to the
 * literal "Claude Opus 4", mislabelling the premium model by two generations,
 * and `SkillList.tsx` kept a second hand-written map of the same vocabulary.
 */
describe('roleModelLabel', () => {
  test('never appends a version to an alias', () => {
    expect(roleModelLabel('opus')).toBe('Opus');
    expect(roleModelLabel('sonnet')).toBe('Sonnet');
    expect(roleModelLabel('haiku')).toBe('Haiku');
    expect(roleModelLabel('opus')).not.toContain('4');
    expect(roleModelLabel('opus')).not.toContain('Claude');
  });

  test('keeps inherit as Inherit', () => {
    expect(roleModelLabel('inherit')).toBe('Inherit');
  });

  test('treats a missing model as Inherit', () => {
    expect(roleModelLabel(null)).toBe('Inherit');
    expect(roleModelLabel('')).toBe('Inherit');
  });

  test('humanises a full model id', () => {
    expect(roleModelLabel('claude-opus-5')).toBe('Opus 5');
    expect(roleModelLabel('claude-sonnet-4-6')).toBe('Sonnet 4.6');
  });

  test('passes an unknown value through', () => {
    expect(roleModelLabel('gpt-5-codex')).toBe('gpt-5-codex');
  });
});

describe('no surface keeps its own humaniser', () => {
  // Asserted as booleans, not with toContain: a failed toContain prints the
  // whole source file into the test log.
  const has = (rel: string, needle: string) =>
    readFileSync(join(WEB_SRC, rel), 'utf8').includes(needle);

  test('the role page no longer hardcodes a model generation', () => {
    const page = 'app/app/(protected)/team/[slug]/page.tsx';
    expect(has(page, 'Claude Opus 4')).toBe(false);
    expect(has(page, 'Claude Sonnet 4')).toBe(false);
    expect(has(page, 'roleModelLabel')).toBe(true);
  });

  test('the skill list no longer keeps a MODEL_LABELS map', () => {
    const list = 'app/app/(protected)/workspaces/[id]/skills/SkillList.tsx';
    expect(has(list, 'MODEL_LABELS')).toBe(false);
    expect(has(list, 'roleModelLabel')).toBe(true);
  });

  test('no task surface strips the claude- prefix by hand', () => {
    for (const rel of [
      'app/app/(protected)/tasks/[id]/page.tsx',
      'app/app/(protected)/tasks/[id]/RealTimeWorkerView.tsx',
      'app/app/(protected)/tasks/[id]/ModelUsagePanel.tsx',
      'app/app/(protected)/tasks/[id]/SessionHistoryPanel.tsx',
    ]) {
      expect({ rel, handRolled: has(rel, "replace('claude-'") }).toEqual({ rel, handRolled: false });
    }
  });

  test('the pending triage row names the tier only, never a model id', () => {
    const src = readFileSync(join(WEB_SRC, 'app/app/(protected)/tasks/[id]/page.tsx'), 'utf8');
    const start = src.indexOf('{isPendingFamily && (');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('{/* Blocked Banner', start));
    expect(block.includes('tierLabel')).toBe(true);
    expect(block.includes('modelId')).toBe(false);
    expect(block.includes('modelLabel')).toBe(false);
  });
});

/**
 * Three values exist per task and are allowed to disagree: the tier requested
 * (`tasks.tier`), the id the router resolved (`predicted_model` +
 * `context.resolvedTier`), and what the SDK reported running
 * (`result_meta.modelUsage`). Every shape below is real.
 */
describe('deriveTaskModel', () => {
  test('leads with the tier, keeps the concrete id as secondary, and names the source', () => {
    const s = deriveTaskModel({
      tier: 'premium',
      predictedModel: 'claude-opus-5',
      context: { model: 'claude-opus-5', resolvedTier: { tier: 'premium', provider: 'anthropic', source: 'workspace' } },
    });
    expect(s.tierLabel).toBe('Premium');
    expect(s.modelId).toBe('claude-opus-5');
    expect(s.modelLabel).toBe('Opus 5');
    expect(s.source).toBe('workspace');
    expect(s.pinned).toBe(false);
    expect(s.isEmpty).toBe(false);
  });

  test('reports the team and default sources verbatim', () => {
    for (const source of ['team', 'default'] as const) {
      const s = deriveTaskModel({
        tier: 'standard',
        predictedModel: 'claude-sonnet-5',
        context: { resolvedTier: { tier: 'standard', provider: 'anthropic', source } },
      });
      expect(s.source).toBe(source);
    }
  });

  test('an explicit pin has no tier — resolvedTier is absent on that path', () => {
    const s = deriveTaskModel({
      tier: null,
      predictedModel: 'claude-sonnet-4-6',
      context: { model: 'claude-sonnet-4-6', routingReason: 'explicit_override' },
    });
    expect(s.pinned).toBe(true);
    expect(s.tierLabel).toBe('Pinned');
    expect(s.modelId).toBe('claude-sonnet-4-6');
    expect(s.modelLabel).toBe('Sonnet 4.6');
    expect(s.source).toBe(null);
  });

  test('a pin still reads as pinned when a tier was also requested', () => {
    // The claim route's explicit_override path bypasses the registry entirely,
    // so the pin is what ran — saying "Premium" here would be a lie.
    const s = deriveTaskModel({
      tier: 'premium',
      predictedModel: 'claude-sonnet-4-6',
      context: { model: 'claude-sonnet-4-6', routingReason: 'explicit_override' },
    });
    expect(s.pinned).toBe(true);
    expect(s.tierLabel).toBe('Pinned');
    expect(s.requestedTier).toBe('premium');
  });

  test('a bare alias (no team) resolves to its tier word, not a pin', () => {
    const s = deriveTaskModel({ tier: null, predictedModel: 'sonnet', context: { model: 'sonnet' } });
    expect(s.pinned).toBe(false);
    expect(s.tierLabel).toBe('Standard');
    expect(s.modelId).toBe('sonnet');
    expect(s.modelLabel).toBe('Sonnet');
    expect(s.source).toBe(null);
  });

  test('maps every legacy alias to a tier word', () => {
    expect(deriveTaskModel({ predictedModel: 'opus' }).tierLabel).toBe('Premium');
    expect(deriveTaskModel({ predictedModel: 'haiku' }).tierLabel).toBe('Budget');
  });

  test('an unclaimed task shows the requested tier alone', () => {
    const s = deriveTaskModel({ tier: 'budget', predictedModel: null, context: null });
    expect(s.tierLabel).toBe('Budget');
    expect(s.modelId).toBe(null);
    expect(s.modelLabel).toBe(null);
    expect(s.isEmpty).toBe(false);
  });

  test('nothing known at all is empty, so the caller can omit the row', () => {
    const s = deriveTaskModel({ tier: null, predictedModel: null, context: null });
    expect(s.isEmpty).toBe(true);
    expect(s.tierLabel).toBe(null);
  });

  test('divergence is reported when the model that ran is not the one assigned', () => {
    const s = deriveTaskModel({
      tier: 'premium',
      predictedModel: 'claude-opus-5',
      context: { resolvedTier: { tier: 'premium', provider: 'anthropic', source: 'team' } },
      modelUsage: { 'claude-sonnet-5': { inputTokens: 100, outputTokens: 50 } },
    });
    expect(s.divergedTo).toBe('Sonnet 5');
    expect(s.actualModelId).toBe('claude-sonnet-5');
  });

  test('an alias assignment agrees with any release in its family', () => {
    const s = deriveTaskModel({
      predictedModel: 'sonnet',
      modelUsage: { 'claude-sonnet-5': { inputTokens: 10, outputTokens: 1 } },
    });
    expect(s.divergedTo).toBe(null);
  });

  test('missing attribution is never divergence', () => {
    // Seat/OAuth auth reports no per-model usage by construction.
    const empty = deriveTaskModel({ predictedModel: 'claude-opus-5', modelUsage: {} });
    expect(empty.divergedTo).toBe(null);
    expect(empty.actualModelId).toBe(null);

    // Codex reports the literal string `codex`, which names no comparable model.
    const codex = deriveTaskModel({
      predictedModel: 'claude-opus-5',
      modelUsage: { codex: { inputTokens: 10, outputTokens: 2 } },
    });
    expect(codex.divergedTo).toBe(null);
  });

  test('several models running is surfaced, and the busiest one wins', () => {
    const s = deriveTaskModel({
      predictedModel: 'claude-opus-5',
      modelUsage: {
        'claude-haiku-4-5': { inputTokens: 10, outputTokens: 1 },
        'claude-opus-5': { inputTokens: 5000, outputTokens: 900 },
      },
    });
    expect(s.actualModelId).toBe('claude-opus-5');
    expect(s.actualModelCount).toBe(2);
    expect(s.divergedTo).toBe(null);
  });

  test("a context model of 'inherit' is no choice at all, not a pin", () => {
    // Callers can put `inherit` in `context.model`; it means "no explicit
    // model", so calling it Pinned would invent a decision nobody made.
    const s = deriveTaskModel({ tier: 'standard', context: { model: 'inherit' } });
    expect(s.pinned).toBe(false);
    expect(s.modelId).toBe(null);
    expect(s.tierLabel).toBe('Standard');

    const bare = deriveTaskModel({ context: { model: 'inherit' } });
    expect(bare.isEmpty).toBe(true);
  });

  test('a tier word in context.model reads as that tier', () => {
    const s = deriveTaskModel({ context: { model: 'premium' } });
    expect(s.pinned).toBe(false);
    expect(s.tierLabel).toBe('Premium');
  });

  test('survives a malformed context without throwing', () => {
    expect(deriveTaskModel({ context: 'not-an-object' }).isEmpty).toBe(true);
    // A malformed context carries no reason, so no pin may be claimed from it.
    expect(deriveTaskModel({ context: { resolvedTier: 'nope' }, predictedModel: 'claude-opus-5' }).pinned).toBe(false);
    expect(
      deriveTaskModel({
        context: { resolvedTier: 'nope', routingReason: 'explicit_override' },
        predictedModel: 'claude-opus-5',
      }).tierLabel,
    ).toBe('Pinned');
    expect(deriveTaskModel({}).isEmpty).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pinned must be a claim we can support, and a downshift must be visible
// ---------------------------------------------------------------------------

describe('routingReason', () => {
  test('says Pinned only on positive evidence', () => {
    const s = deriveTaskModel({
      predictedModel: 'claude-opus-5',
      context: { model: 'claude-opus-5', routingReason: 'explicit_override' },
    });
    expect(s.pinned).toBe(true);
    expect(s.tierLabel).toBe('Pinned');
  });

  test('does NOT say Pinned when the reason is unknown', () => {
    // A task claimed before `routingReason` shipped has a concrete id and no
    // resolvedTier — which is also what a pin looks like. Inferring "Pinned"
    // there labels historical tier-routed tasks with a decision nobody made.
    const s = deriveTaskModel({
      tier: 'premium',
      predictedModel: 'claude-opus-5',
      context: { model: 'claude-opus-5' },
    });
    expect(s.pinned).toBe(false);
    expect(s.tierLabel).not.toBe('Pinned');
    // The tier it was requested with is still the honest label.
    expect(s.tierLabel).toBe('Premium');
  });

  test('a budget downshift is surfaced, not hidden', () => {
    // The user-visible symptom is "my task ran on something cheap". Without the
    // reason that reads as a deliberate choice.
    const s = deriveTaskModel({
      tier: 'premium',
      predictedModel: 'claude-haiku-4-5-20251001',
      context: { model: 'claude-haiku-4-5-20251001', routingReason: 'budget_downshift' },
    });
    expect(s.downshifted).toBe(true);
    expect(s.reasonLabel).toBe('budget downshift');
  });

  test('a baseline resolution advertises no special reason', () => {
    const s = deriveTaskModel({
      tier: 'standard',
      predictedModel: 'claude-sonnet-5',
      context: {
        model: 'claude-sonnet-5',
        routingReason: 'baseline',
        resolvedTier: { tier: 'standard', provider: 'anthropic', source: 'team' },
      },
    });
    expect(s.downshifted).toBe(false);
    expect(s.reasonLabel).toBeNull();
    expect(s.source).toBe('team');
  });
});
