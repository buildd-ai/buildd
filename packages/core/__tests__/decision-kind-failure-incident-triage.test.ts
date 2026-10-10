import { describe, expect, it } from 'bun:test';
import {
  FAILURE_INCIDENT_TRIAGE_CONFIG,
  FAILURE_INCIDENT_TRIAGE_DECISIONS,
  failureIncidentTriageKind,
  parseFailureIncidentTriageFeatures,
  type FailureIncidentTriageFeatures,
} from '../decision-kind-failure-incident-triage';
import { listBuilddDecisionKinds } from '../decision-kinds';
import { INFERENCE_CAPABILITIES } from '../inference-policy';

const base: FailureIncidentTriageFeatures = {
  rule: 'repeated_failure',
  floorSeverity: 'medium',
  occurrenceCount: 4,
  distinctTasks: 3,
  recurrenceCount: 0,
  spanMinutes: 30,
  transientOrBudget: false,
};

describe('buildd.failure_incident_triage kind', () => {
  it('is registered against its own opt-in capability, live', () => {
    expect(listBuilddDecisionKinds().map(k => k.kind)).toContain('buildd.failure_incident_triage');
    expect(failureIncidentTriageKind.binding).toMatchObject({ capability: 'failure_incident_triage', mode: 'live' });
    expect(INFERENCE_CAPABILITIES.failure_incident_triage.kind).toBe('opt_in');
  });

  it('decides among exactly the four typed outcomes', () => {
    expect([...FAILURE_INCIDENT_TRIAGE_DECISIONS]).toEqual(['known_noise', 'monitor', 'systemic_bug', 'page_now']);
  });

  it('a critical floor is a rule: page_now, no model asked', () => {
    const parsed = parseFailureIncidentTriageFeatures({ ...base, floorSeverity: 'critical' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(FAILURE_INCIDENT_TRIAGE_CONFIG.override?.(parsed.features)).toEqual({
      decision: 'page_now',
      reasonCode: 'critical_floor_repeated_failure',
    });
  });

  it('a non-critical floor goes to the model', () => {
    const parsed = parseFailureIncidentTriageFeatures(base);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(FAILURE_INCIDENT_TRIAGE_CONFIG.override?.(parsed.features)).toBeNull();
  });

  it('falls back deterministically from the floor, never above it', () => {
    const parsed = parseFailureIncidentTriageFeatures({ ...base, floorSeverity: 'high' });
    if (!parsed.ok) throw new Error(parsed.message);
    expect(FAILURE_INCIDENT_TRIAGE_CONFIG.fallback(parsed.features, 'provider_failure')).toEqual({
      decision: 'systemic_bug', reasonCode: 'fallback_provider_failure',
    });
    const med = parseFailureIncidentTriageFeatures(base);
    if (!med.ok) throw new Error(med.message);
    expect(FAILURE_INCIDENT_TRIAGE_CONFIG.fallback(med.features, 'no_provider').decision).toBe('monitor');
  });

  it('refuses unknown rules, severities and non-count values', () => {
    expect(parseFailureIncidentTriageFeatures({ ...base, rule: 'made_up' }).ok).toBe(false);
    expect(parseFailureIncidentTriageFeatures({ ...base, floorSeverity: 'severe' }).ok).toBe(false);
    expect(parseFailureIncidentTriageFeatures({ ...base, occurrenceCount: -1 }).ok).toBe(false);
    expect(parseFailureIncidentTriageFeatures({ ...base, transientOrBudget: 'yes' }).ok).toBe(false);
    expect(parseFailureIncidentTriageFeatures(null).ok).toBe(false);
  });

  it('clamps large counters so the feature digest stays bounded', () => {
    const parsed = parseFailureIncidentTriageFeatures({ ...base, occurrenceCount: 10_000_000 });
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.features.occurrenceCount).toBe(100_000);
  });

  it('carries a stable reason code from the model answer', () => {
    const out = FAILURE_INCIDENT_TRIAGE_CONFIG.interpret({
      decision: { choice: 'systemic_bug', confidence: 0.9 },
      cause: { choice: 'platform_defect', confidence: 0.8 },
    } as never);
    expect(out).toEqual({ decision: 'systemic_bug', confidence: 0.9, reasonCode: 'cause_platform_defect' });
  });
});
