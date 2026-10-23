import { describe, expect, it } from 'bun:test';
import {
  RED_CHECK_CAUSE_CONFIG,
  RED_CHECK_CAUSE_DECISIONS,
  parseRedCheckCauseFeatures,
  redCheckCauseKind,
} from '../decision-kind-red-check-cause';
import { listBuilddDecisionKinds } from '../decision-kinds';
import { INFERENCE_CAPABILITIES } from '../inference-policy';
import { decisionModelKindLabel } from '../decision-model';

const jobs = [{ name: 'e2e', step: 'Run e2e', lines: 'Error: page.goto: net::ERR_CONNECTION_RESET' }];

describe('buildd.red_check_cause kind', () => {
  it('is registered against its own opt-in capability', () => {
    expect(listBuilddDecisionKinds().map(k => k.kind)).toContain('buildd.red_check_cause');
    expect(redCheckCauseKind.binding).toMatchObject({ capability: 'red_check_cause', mode: 'live' });
    expect(INFERENCE_CAPABILITIES.red_check_cause.kind).toBe('opt_in');
    expect(decisionModelKindLabel('buildd.red_check_cause')).toBe('Red check cause');
    expect([...RED_CHECK_CAUSE_DECISIONS]).toEqual(['environment', 'code']);
  });

  it('never decides by rule: the rules already ran', () => {
    expect(RED_CHECK_CAUSE_CONFIG.override?.({ jobs })).toBeNull();
  });

  it('every fallback reads the failure as the code, including unparseable features', () => {
    for (const cause of ['no_provider', 'low_confidence', 'provider_failure', 'invalid_features'] as const) {
      expect(RED_CHECK_CAUSE_CONFIG.fallback({ jobs }, cause).decision).toBe('code');
      expect(RED_CHECK_CAUSE_CONFIG.fallback(null, cause).decision).toBe('code');
    }
  });

  it('refuses malformed features, bounds the rest and keeps the end of long lines', () => {
    expect(parseRedCheckCauseFeatures(null).ok).toBe(false);
    expect(parseRedCheckCauseFeatures({ jobs: [] }).ok).toBe(false);
    expect(parseRedCheckCauseFeatures({ jobs: [{ name: 1, lines: 'x' }] }).ok).toBe(false);
    expect(parseRedCheckCauseFeatures({ jobs: [{ name: 'a', step: null, lines: '  ' }] }).ok).toBe(false);
    const p = parseRedCheckCauseFeatures({ jobs: [...Array(5)].map((_, i) => ({ name: `j${i}`, step: null, lines: `${'x'.repeat(5_000)}END` })) });
    if (!p.ok) throw new Error(p.message);
    expect(p.features.jobs).toHaveLength(3);
    expect(p.features.jobs[0].lines).toHaveLength(2_000);
    expect(p.features.jobs[0].lines.endsWith('END')).toBe(true);
  });

  it('interprets the model answer with its confidence', () => {
    const out = RED_CHECK_CAUSE_CONFIG.interpret({ decision: { choice: 'environment', confidence: 0.9 } } as never);
    expect(out).toEqual({ decision: 'environment', confidence: 0.9, reasonCode: 'cause_environment' });
  });
});
