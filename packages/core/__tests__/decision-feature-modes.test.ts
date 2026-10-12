import { describe, it, expect } from 'bun:test';
import { ALL_INFERENCE_CAPABILITIES } from '../inference-policy';
import {
  FEATURE_EFFECT,
  MANIFEST_ACTING_DEFAULT_THRESHOLD,
  SWITCHABLE_FEATURES,
  describeFeatureMode,
  manifestPromotionFromRow,
  planFeatureSwitch,
  storedRowMatches,
  type StoredFeatureMode,
} from '../decision-feature-modes';
import { manifestPickIdentity, resolveApplyingFraction } from '../orchestration-promotion';
import { buildPickDecision, MANIFEST_CANDIDATE_POLICY_VERSION, MANIFEST_PICK_QUESTION } from '../manifest-prediction';

const row = (over: Partial<StoredFeatureMode> = {}): StoredFeatureMode => ({
  feature: 'orchestration_manifest',
  mode: 'acting',
  applyingFraction: 1,
  measuredFingerprint: manifestPickIdentity(),
  threshold: 0.9,
  setByAccountId: null,
  setAt: new Date('2026-01-05T10:00:00Z'),
  reason: null,
  ...over,
});

describe('feature map', () => {
  it('names an effect for every inference capability', () => {
    for (const id of ALL_INFERENCE_CAPABILITIES) expect(FEATURE_EFFECT[id]).toBeDefined();
  });

  it('only a recording-only feature with an apply path is switchable', () => {
    for (const id of Object.keys(SWITCHABLE_FEATURES)) expect(FEATURE_EFFECT[id as keyof typeof FEATURE_EFFECT]).toBe('records');
    expect(Object.keys(SWITCHABLE_FEATURES)).toEqual(['orchestration_manifest']);
  });
});

describe('describeFeatureMode', () => {
  it('a switchable feature with no row records, and can be switched', () => {
    const v = describeFeatureMode('orchestration_manifest', null);
    expect(v).toMatchObject({ mode: 'recording', switchable: true, canAct: true });
    expect(v.cannotActReason).toBeUndefined();
    expect(v.stale).toBeUndefined();
  });

  it('a matching acting row acts, with its threshold and start time', () => {
    const v = describeFeatureMode('orchestration_manifest', row({ threshold: 0.8 }));
    expect(v).toMatchObject({ mode: 'acting', switchable: true, threshold: 0.8, actingSince: '2026-01-05T10:00:00.000Z' });
  });

  it('an acting row whose questions or model changed falls back to recording and says why', () => {
    const v = describeFeatureMode('orchestration_manifest', row({ measuredFingerprint: 'changed' }));
    expect(v.mode).toBe('recording');
    expect(v.stale).toContain('changed');
  });

  it('a recording row is recording', () => {
    expect(describeFeatureMode('orchestration_manifest', row({ mode: 'recording' })).mode).toBe('recording');
  });

  it('a feature that acts by design reads acting with no switch', () => {
    const v = describeFeatureMode('task_role_shadow', null);
    expect(v).toMatchObject({ mode: 'acting', effect: 'acts', switchable: false, canAct: true });
    expect(v.cannotActReason).toBeTruthy();
  });

  it('an advisory feature reads acting (it reaches a person) with no switch', () => {
    expect(describeFeatureMode('merge_readiness', null)).toMatchObject({ mode: 'acting', effect: 'advises', switchable: false });
  });

  it('a retired or unused feature cannot act', () => {
    expect(describeFeatureMode('heartbeat_triage', null)).toMatchObject({ mode: 'recording', canAct: false, switchable: false });
    expect(describeFeatureMode('visual_qa', null)).toMatchObject({ canAct: false, switchable: false });
  });
});

describe('planFeatureSwitch', () => {
  it('rejects an unknown feature with 404', () => {
    expect(planFeatureSwitch('no_such_feature', { mode: 'acting' })).toMatchObject({ ok: false, status: 404 });
  });

  it('rejects a bad body with 400', () => {
    expect(planFeatureSwitch('orchestration_manifest', null)).toMatchObject({ ok: false, status: 400 });
    expect(planFeatureSwitch('orchestration_manifest', { mode: 'live' })).toMatchObject({ ok: false, status: 400 });
    expect(planFeatureSwitch('orchestration_manifest', { mode: 'acting', extra: 1 })).toMatchObject({ ok: false, status: 400 });
    expect(planFeatureSwitch('orchestration_manifest', { mode: 'acting', threshold: 1.5 })).toMatchObject({ ok: false, status: 400 });
    expect(planFeatureSwitch('orchestration_manifest', { mode: 'acting', threshold: 0.2 })).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses a feature with no switch with 409 and the reason', () => {
    const r = planFeatureSwitch('task_role_shadow', { mode: 'acting' });
    expect(r).toMatchObject({ ok: false, status: 409 });
    if (!r.ok) expect(r.error).toBe(describeFeatureMode('task_role_shadow', null).cannotActReason!);
  });

  it('acting pins today\'s identity and the default threshold', () => {
    const r = planFeatureSwitch('orchestration_manifest', { mode: 'acting', reason: ' measured ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row).toMatchObject({ mode: 'acting', applyingFraction: 1, threshold: MANIFEST_ACTING_DEFAULT_THRESHOLD, measuredFingerprint: manifestPickIdentity(), reason: 'measured' });
    }
  });

  it('acting takes an owner threshold inside the range', () => {
    const r = planFeatureSwitch('orchestration_manifest', { mode: 'acting', threshold: 0.75 });
    expect(r.ok && r.row.threshold).toBe(0.75);
  });

  it('recording always succeeds and clears the pin', () => {
    const r = planFeatureSwitch('orchestration_manifest', { mode: 'recording' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row).toMatchObject({ mode: 'recording', applyingFraction: 0, measuredFingerprint: null, threshold: null });
  });
});

describe('manifest promotion from a stored row', () => {
  const gatedPick = (minConfidence: number) => buildPickDecision(['a.ts', 'b.ts'], { mode: 'gated', minConfidence }).decision;
  const fraction = (r: StoredFeatureMode | null, minConfidence = 0.9) => {
    const ev = manifestPromotionFromRow(r);
    return resolveApplyingFraction({
      decision: gatedPick(minConfidence),
      question: MANIFEST_PICK_QUESTION,
      candidatePolicyVersion: MANIFEST_CANDIDATE_POLICY_VERSION,
      requestedFraction: r?.applyingFraction ?? 0,
      identity: manifestPickIdentity(),
      promotions: ev ? [ev] : [],
    });
  };

  it('a matching acting row grants the whole cohort', () => {
    expect(fraction(row())).toEqual({ fraction: 1, refusal: null });
  });

  it('a stale or recording row grants nothing', () => {
    expect(manifestPromotionFromRow(row({ measuredFingerprint: 'changed' }))).toBeNull();
    expect(manifestPromotionFromRow(row({ mode: 'recording' }))).toBeNull();
    expect(fraction(row({ measuredFingerprint: 'changed' })).fraction).toBe(0);
  });

  it('the threshold the pick is built with must equal the stored one', () => {
    expect(fraction(row({ threshold: 0.9 }), 0.8)).toMatchObject({ fraction: 0, refusal: 'threshold_mismatch' });
  });

  it('storedRowMatches needs a threshold and a positive fraction', () => {
    expect(storedRowMatches('orchestration_manifest', row({ threshold: null }))).toBe(false);
    expect(storedRowMatches('orchestration_manifest', row({ applyingFraction: 0 }))).toBe(false);
    expect(storedRowMatches('task_role_shadow', row({ feature: 'task_role_shadow' }))).toBe(false);
  });
});
