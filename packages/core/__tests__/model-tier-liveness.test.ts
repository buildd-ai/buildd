import { describe, test, expect } from 'bun:test';
import { TIER_DEFAULTS } from '../model-tier-defaults';
import { auditTierModels, type LiveModel } from '../model-tier-liveness';

/**
 * The routing defaults are a POLICY choice (which model is our standard tier),
 * so `GET /v1/models` cannot supply them. What it can do is prove the choice is
 * still valid: that the configured ID exists, and that we are not sitting a
 * generation behind a cheaper model in the same family.
 *
 * This is what nobody checked. `standard` shipped as `claude-sonnet-4-6` for
 * months after `claude-sonnet-5` shipped at a LOWER price ($2/$10 vs $3/$15),
 * and the only thing that would have caught it was a human noticing.
 */

// Shape of a real /v1/models page, trimmed to the fields we use.
const LIVE: LiveModel[] = [
  { id: 'claude-fable-5', display_name: 'Claude Fable 5' },
  { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
  { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
  { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' },
];

describe('auditTierModels', () => {
  test('every tier default resolves to a live model ID', () => {
    const { unknown } = auditTierModels(TIER_DEFAULTS, LIVE);
    expect(unknown).toEqual([]);
  });

  test('no tier default is superseded by a newer model in its own family', () => {
    const { superseded } = auditTierModels(TIER_DEFAULTS, LIVE);
    expect(superseded).toEqual([]);
  });

  test('flags an ID the API does not return (retired or typo)', () => {
    const { unknown } = auditTierModels(
      { standard: { provider: 'anthropic', model: 'claude-sonnet-9' } },
      LIVE,
    );
    expect(unknown).toEqual([{ tier: 'standard', model: 'claude-sonnet-9' }]);
  });

  test('flags a generation-behind default — the exact drift that shipped', () => {
    const { superseded } = auditTierModels(
      { standard: { provider: 'anthropic', model: 'claude-sonnet-4-6' } },
      LIVE,
    );
    expect(superseded).toEqual([
      { tier: 'standard', model: 'claude-sonnet-4-6', newer: 'claude-sonnet-5' },
    ]);
  });

  test('ignores non-anthropic providers — /v1/models cannot speak for them', () => {
    const audit = auditTierModels(
      { standard: { provider: 'openai-codex', model: 'gpt-5-codex' } },
      LIVE,
    );
    expect(audit.unknown).toEqual([]);
    expect(audit.superseded).toEqual([]);
  });

  test('an empty live list audits nothing rather than condemning everything', () => {
    // A failed or unauthenticated /v1/models call must not report every model
    // as retired — that is the empty-set false alarm, the inverse of a vacuous pass.
    const audit = auditTierModels(TIER_DEFAULTS, []);
    expect(audit.unknown).toEqual([]);
    expect(audit.superseded).toEqual([]);
    expect(audit.checked).toBe(false);
  });
});

// Alias/tier agreement is already pinned by model-aliases-surface.test.ts (#1988).
