import { describe, it, expect } from 'bun:test';
import { defineDecisionKind, runDecisionKind } from '@builddai/ai-kit/decide';
import { listBuilddDecisionKinds } from '../decision-kinds';
import {
  POST_SESSION_TRIAGE_CONFIG,
  TRIAGE_UNAVAILABLE,
  parsePostSessionTriageFeatures,
  postSessionTriageKind,
  postSessionTriageObjective,
  triageFocusOf,
  type PostSessionTriageFeatures,
} from '../decision-kind-post-session-triage';
import {
  SCOUT_PROBE_SELECTION_CONFIG,
  parseScoutProbeFeatures,
  scoutProbeSelectionKind,
  scoutProbeSelectionObjective,
  type ScoutProbeFeatures,
} from '../decision-kind-scout-probe-selection';
import { OPT_IN_CAPABILITIES } from '../inference-policy';

/**
 * The two first-party kinds share the substrate (one request/response
 * contract, one plan) but own their features, overrides, fallbacks and
 * objectives. Nothing here reaches a provider: no runtime route is given.
 */

const triage = (over: Partial<PostSessionTriageFeatures> = {}): PostSessionTriageFeatures => ({
  sessionFailed: false, retried: false, prShipped: true, merged: true, reviewRounds: 1, requestChanges: 0,
  ciFixAttempts: 0, errorTotal: 0, transcriptPresent: true, unreadSources: 0, hardTriggers: [], ...over,
});
const probe = (over: Partial<ScoutProbeFeatures> = {}): ScoutProbeFeatures => ({
  probeKind: 'api_contract', supported: true, mustRun: false, touchesChangedPaths: true,
  priorFailures: 0, changedFiles: 4, budgetRemaining: 3, ...over,
});

describe('registration', () => {
  it('both kinds are registered buildd kinds bound to their own capabilities and rollout modes', () => {
    const ids = listBuilddDecisionKinds().map(k => k.kind);
    expect(ids).toContain('buildd.post_session_triage');
    expect(ids).toContain('buildd.scout_probe_selection');
    expect(postSessionTriageKind.binding).toMatchObject({ capability: 'post_session_triage', mode: 'live' });
    expect(scoutProbeSelectionKind.binding).toMatchObject({ capability: 'scout_probe_selection', mode: 'shadow' });
    expect(OPT_IN_CAPABILITIES).toContain('scout_probe_selection');
  });

  it('own disjoint decision sets and independent version fields', () => {
    expect([...postSessionTriageKind.decisions]).toEqual(['skip', 'analyse']);
    expect([...scoutProbeSelectionKind.decisions]).toEqual(['run', 'defer', 'unsupported']);
    expect(postSessionTriageKind.policyVersion).not.toBe(scoutProbeSelectionKind.policyVersion);
    expect(postSessionTriageKind.featureSchemaVersion).not.toBe(scoutProbeSelectionKind.featureSchemaVersion);
    expect(postSessionTriageKind.promptFingerprint).not.toBe(scoutProbeSelectionKind.promptFingerprint);
  });

  it('bumping a policy version moves no other version field', () => {
    for (const config of [POST_SESSION_TRIAGE_CONFIG, SCOUT_PROBE_SELECTION_CONFIG] as const) {
      const base = defineDecisionKind(config as typeof POST_SESSION_TRIAGE_CONFIG);
      const bumped = defineDecisionKind({ ...(config as typeof POST_SESSION_TRIAGE_CONFIG), policyVersion: 'bumped' });
      expect(bumped.policyVersion).toBe('bumped');
      expect(bumped.featureSchemaVersion).toBe(base.featureSchemaVersion);
      expect(bumped.promptFingerprint).toBe(base.promptFingerprint);
      expect(bumped.configFingerprint).toBe(base.configFingerprint);
    }
  });
});

describe('post_session_triage features', () => {
  it('accepts bounded counters, clamps them, and canonicalises the trigger order', () => {
    const r = parsePostSessionTriageFeatures({ ...triage(), errorTotal: 5_000, hardTriggers: ['review_fix_loop', 'reviewer_escalated', 'review_fix_loop'] });
    expect(r).toMatchObject({ ok: true, features: { errorTotal: 1_000, hardTriggers: ['reviewer_escalated', 'review_fix_loop'] } });
  });

  it('keeps unknown as null and refuses text, negatives and unknown triggers', () => {
    expect(parsePostSessionTriageFeatures(triage({ retried: null, ciFixAttempts: null })).ok).toBe(true);
    expect(parsePostSessionTriageFeatures({ ...triage(), errorTotal: -1 }).ok).toBe(false);
    expect(parsePostSessionTriageFeatures({ ...triage(), sessionFailed: 'no' }).ok).toBe(false);
    expect(parsePostSessionTriageFeatures({ ...triage(), hardTriggers: ['made_up'] }).ok).toBe(false);
    expect(parsePostSessionTriageFeatures('a transcript').ok).toBe(false);
  });

  it('never shows the model the trigger list', () => {
    expect(postSessionTriageKind.state(triage())).not.toHaveProperty('hardTriggers');
  });
});

describe('scout_probe_selection features', () => {
  it('accepts a known probe kind with bounded counters and refuses anything else', () => {
    expect(parseScoutProbeFeatures({ ...probe(), changedFiles: 99_999 })).toMatchObject({ ok: true, features: { changedFiles: 10_000 } });
    expect(parseScoutProbeFeatures({ ...probe(), probeKind: 'rm -rf' }).ok).toBe(false);
    expect(parseScoutProbeFeatures({ ...probe(), budgetRemaining: 1.5 }).ok).toBe(false);
  });

  it('never shows the model the rule inputs', () => {
    const s = scoutProbeSelectionKind.state(probe()) as Record<string, unknown>;
    expect(s).not.toHaveProperty('mustRun');
    expect(s).not.toHaveProperty('supported');
  });
});

describe('overrides and fallbacks are each kind\'s own', () => {
  const noRoute = { mode: 'live' as const, cheap: null };

  it('triage: any hard trigger forces analyse, in every mode, with no model', async () => {
    for (const mode of ['live', 'shadow', 'disabled'] as const) {
      const r = await runDecisionKind(postSessionTriageKind, { features: triage({ hardTriggers: ['success_without_evidence'] }) }, { mode, cheap: null });
      expect(r).toMatchObject({ decision: 'analyse', source: 'rule', deterministicOverride: true, reasonCode: 'hard_trigger_success_without_evidence', attempts: [] });
    }
  });

  it('triage: fails open to skip, triage_unavailable when no model answered', async () => {
    expect(await runDecisionKind(postSessionTriageKind, { features: triage() }, noRoute)).toMatchObject({ decision: 'skip', fallbackCause: 'no_provider', reasonCode: TRIAGE_UNAVAILABLE });
    expect(await runDecisionKind(postSessionTriageKind, { features: { nope: 1 } as unknown as PostSessionTriageFeatures }, noRoute)).toMatchObject({ decision: 'skip', fallbackCause: 'invalid_features', reasonCode: TRIAGE_UNAVAILABLE });
    expect(await runDecisionKind(postSessionTriageKind, { features: triage() }, { mode: 'disabled' })).toMatchObject({ decision: 'skip', reasonCode: TRIAGE_UNAVAILABLE });
  });

  it('scout: unsupported beats must-run beats an empty budget', async () => {
    const run = (f: ScoutProbeFeatures) => runDecisionKind(scoutProbeSelectionKind, { features: f }, noRoute);
    expect(await run(probe({ supported: false, mustRun: true }))).toMatchObject({ decision: 'unsupported', reasonCode: 'executor_unsupported', source: 'rule' });
    expect(await run(probe({ mustRun: true, budgetRemaining: 0 }))).toMatchObject({ decision: 'run', reasonCode: 'must_run', source: 'rule' });
    expect(await run(probe({ budgetRemaining: 0 }))).toMatchObject({ decision: 'defer', reasonCode: 'budget_exhausted', source: 'rule' });
  });

  it('scout: fallback leans toward coverage, and defers what it cannot read', async () => {
    expect(await runDecisionKind(scoutProbeSelectionKind, { features: probe() }, noRoute)).toMatchObject({ decision: 'run', reasonCode: 'heuristic_run_no_provider' });
    expect(await runDecisionKind(scoutProbeSelectionKind, { features: probe({ touchesChangedPaths: false }) }, noRoute)).toMatchObject({ decision: 'defer' });
    expect(await runDecisionKind(scoutProbeSelectionKind, { features: { probeKind: 'x' } as unknown as ScoutProbeFeatures }, noRoute)).toMatchObject({ decision: 'defer', fallbackCause: 'invalid_features' });
  });

  it('refuses features built against another schema version rather than guessing', async () => {
    const r = await runDecisionKind(scoutProbeSelectionKind, { features: probe(), featureSchemaVersion: 'spsel-features-v0' }, noRoute);
    expect(r).toMatchObject({ source: 'fallback', fallbackCause: 'invalid_features', featureDigest: null });
  });
});

describe('objectives', () => {
  it('triage scores analyse on actionable and skip on not_actionable', () => {
    expect(postSessionTriageObjective.score({ label: 'actionable', value: null }, 'analyse')).toBe(true);
    expect(postSessionTriageObjective.score({ label: 'actionable', value: null }, 'skip')).toBe(false);
    expect(postSessionTriageObjective.score({ label: 'not_actionable', value: null }, 'skip')).toBe(true);
    expect(postSessionTriageObjective.score({ label: 'something_else', value: null }, 'skip')).toBeNull();
  });

  it('scout scores run on a defect and defer on none, and never scores unsupported', () => {
    expect(scoutProbeSelectionObjective.score({ label: 'defect_found', value: null }, 'run')).toBe(true);
    expect(scoutProbeSelectionObjective.score({ label: 'no_defect', value: null }, 'run')).toBe(false);
    expect(scoutProbeSelectionObjective.score({ label: 'no_defect', value: null }, 'defer')).toBe(true);
    expect(scoutProbeSelectionObjective.score({ label: 'defect_found', value: null }, 'unsupported')).toBeNull();
  });

  it('triage focus round-trips through the reason code, and rules carry none', () => {
    expect(triageFocusOf({ reasonCode: 'focus_retrieval' })).toBe('retrieval');
    expect(triageFocusOf({ reasonCode: 'focus_bogus' })).toBeNull();
    expect(triageFocusOf({ reasonCode: 'hard_trigger_reviewer_escalated' })).toBeNull();
  });
});
