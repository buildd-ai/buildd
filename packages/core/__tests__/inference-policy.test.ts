import { describe, it, expect } from 'bun:test';
import {
  INFERENCE_CAPABILITIES,
  ALL_INFERENCE_CAPABILITIES,
  SERVER_FEATURES,
  LIVE_SERVER_FEATURES,
  isInferenceCapability,
  isInferenceAllowed,
  normalizeDecisionShadows,
  normalizeFeatureModes,
  OPT_IN_CAPABILITIES,
  resolveFeatureMode,
} from '../inference-policy';

/**
 * Which calls may spend a provider key. Three kinds:
 * - interactive (chat): always on; it runs whenever a key resolves. No switch.
 * - built-in decision calls: always allowed; they run when a key resolves.
 * - server-side features: default by billing model, per-feature override `runner`.
 */

describe('isInferenceAllowed', () => {
  it('allows every non-opt_in capability on a team that never touched a setting', () => {
    for (const c of ALL_INFERENCE_CAPABILITIES) {
      expect(isInferenceAllowed(c, { featureModes: null })).toBe(INFERENCE_CAPABILITIES[c].kind !== 'opt_in');
    }
  });

  it('an opt_in capability runs only when the team lists it', () => {
    expect(OPT_IN_CAPABILITIES).toContain('task_role_shadow');
    expect(isInferenceAllowed('task_role_shadow', { featureModes: null })).toBe(false);
    expect(isInferenceAllowed('task_role_shadow', { enabledDecisionShadows: null })).toBe(false);
    expect(isInferenceAllowed('task_role_shadow', { enabledDecisionShadows: [] })).toBe(false);
    expect(isInferenceAllowed('task_role_shadow', { enabledDecisionShadows: 'task_role_shadow' })).toBe(false);
    expect(isInferenceAllowed('task_role_shadow', { enabledDecisionShadows: ['task_role_shadow'] })).toBe(true);
    // A server-feature override never turns it on.
    expect(isInferenceAllowed('task_role_shadow', { featureModes: { task_role_shadow: 'server' } })).toBe(false);
  });

  it('listing an opt_in capability turns on nothing else', () => {
    const gate = { featureModes: { criteria_grading: 'runner' }, enabledDecisionShadows: ['task_role_shadow'] };
    expect(isInferenceAllowed('criteria_grading', gate)).toBe(false);
  });

  it('turning the role shadow on never turns on role apply', () => {
    expect(OPT_IN_CAPABILITIES).toContain('task_role_apply');
    expect(isInferenceAllowed('task_role_apply', { enabledDecisionShadows: ['task_role_shadow'] })).toBe(false);
    expect(isInferenceAllowed('task_role_apply', { enabledDecisionShadows: ['task_role_apply'] })).toBe(true);
  });

  it('never gates the built-in decision calls', () => {
    const gate = { featureModes: { task_classification: 'runner', task_category: 'runner' } };
    expect(isInferenceAllowed('task_classification', gate)).toBe(true);
    expect(isInferenceAllowed('task_category', gate)).toBe(true);
  });

  it('never gates chat, whatever the deprecated chat_disabled column holds', () => {
    const gate = { chatDisabled: true, featureModes: null } as Parameters<typeof isInferenceAllowed>[1];
    expect(isInferenceAllowed('chat', gate)).toBe(true);
    expect(isInferenceAllowed('chat', { featureModes: { chat: 'runner' } })).toBe(true);
  });

  it('sends a server-side feature to the runner when overridden', () => {
    const gate = { featureModes: { visual_qa: 'runner' } };
    expect(isInferenceAllowed('visual_qa', gate)).toBe(false);
    expect(isInferenceAllowed('criteria_grading', gate)).toBe(true);
    expect(isInferenceAllowed('mission_summary', gate)).toBe(true);
  });

  it('fails closed on a missing team row', () => {
    for (const c of ALL_INFERENCE_CAPABILITIES) expect(isInferenceAllowed(c, null)).toBe(false);
  });

  it('ignores garbage in the stored modes', () => {
    expect(isInferenceAllowed('criteria_grading', { featureModes: 'runner' })).toBe(true);
    expect(isInferenceAllowed('criteria_grading', { featureModes: { criteria_grading: 'off' } })).toBe(true);
  });
});

describe('resolveFeatureMode', () => {
  it('defaults to server-side when the team has a pay-per-token key', () => {
    expect(resolveFeatureMode('criteria_grading', null, true)).toEqual({ mode: 'server', source: 'default', needsKey: false });
  });

  it('defaults to the runner when no team key resolves (subscription only)', () => {
    expect(resolveFeatureMode('criteria_grading', null, false)).toEqual({ mode: 'runner', source: 'default', needsKey: false });
  });

  it('honours an override either way', () => {
    expect(resolveFeatureMode('visual_qa', { visual_qa: 'runner' }, true)).toEqual({ mode: 'runner', source: 'override', needsKey: false });
    expect(resolveFeatureMode('visual_qa', { visual_qa: 'server' }, false)).toEqual({ mode: 'server', source: 'override', needsKey: true });
  });
});

describe('normalizeFeatureModes', () => {
  it('keeps known features with a known mode', () => {
    expect(normalizeFeatureModes({ criteria_grading: 'runner', visual_qa: 'server' }))
      .toEqual({ criteria_grading: 'runner', visual_qa: 'server' });
  });

  it('drops built-ins, chat, unknown names and unknown modes', () => {
    expect(normalizeFeatureModes({ chat: 'runner', task_classification: 'runner', nope: 'server', mission_summary: 'maybe' })).toBeNull();
  });

  it('treats "default" as clearing the override', () => {
    expect(normalizeFeatureModes({ criteria_grading: 'default', visual_qa: 'runner' })).toEqual({ visual_qa: 'runner' });
  });

  it('collapses every empty form to null', () => {
    expect(normalizeFeatureModes({})).toBeNull();
    expect(normalizeFeatureModes(null)).toBeNull();
    expect(normalizeFeatureModes(['runner'])).toBeNull();
    expect(normalizeFeatureModes('runner')).toBeNull();
  });
});

describe('the capability registry', () => {
  it('keys every descriptor by its own id', () => {
    for (const [key, d] of Object.entries(INFERENCE_CAPABILITIES)) expect(d.id).toBe(key);
  });

  it('shows only server-side features that have a call site', () => {
    // Visual QA judgment and mission summaries have no call site yet: a switch
    // for them would claim a behaviour that does not exist.
    expect([...LIVE_SERVER_FEATURES]).toEqual(['criteria_grading', 'heartbeat_triage']);
    for (const f of LIVE_SERVER_FEATURES) expect(SERVER_FEATURES).toContain(f);
  });

  it('classifies every capability', () => {
    expect([...SERVER_FEATURES]).toEqual(['criteria_grading', 'visual_qa', 'mission_summary', 'heartbeat_triage']);
    for (const f of SERVER_FEATURES) expect(INFERENCE_CAPABILITIES[f].kind).toBe('server_feature');
    expect(INFERENCE_CAPABILITIES.chat.kind).toBe('interactive');
    expect(INFERENCE_CAPABILITIES.task_classification.kind).toBe('built_in');
    expect(INFERENCE_CAPABILITIES.task_category.kind).toBe('built_in');
  });

  it('gives every server-side feature a one-line label and description', () => {
    for (const f of SERVER_FEATURES) {
      const d = INFERENCE_CAPABILITIES[f];
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.description.split('. ').length).toBeLessThanOrEqual(2);
      expect(d.description.length).toBeLessThanOrEqual(100);
    }
  });

  it('recognises exactly its own capability names', () => {
    for (const c of ALL_INFERENCE_CAPABILITIES) expect(isInferenceCapability(c)).toBe(true);
    expect(isInferenceCapability('criteria_grading ')).toBe(false);
    expect(isInferenceCapability(null)).toBe(false);
  });
});

describe('normalizeDecisionShadows', () => {
  it('accepts opt_in capability ids, deduped; empty or null stores null', () => {
    expect(normalizeDecisionShadows(['task_role_shadow', 'task_role_shadow'])).toEqual({ ok: true, value: ['task_role_shadow'] });
    expect(normalizeDecisionShadows([])).toEqual({ ok: true, value: null });
    expect(normalizeDecisionShadows(null)).toEqual({ ok: true, value: null });
  });

  it('rejects unknown and non-opt_in ids instead of dropping them', () => {
    expect(normalizeDecisionShadows(['task_role_shadw']).ok).toBe(false);
    expect(normalizeDecisionShadows(['task_category']).ok).toBe(false);
    expect(normalizeDecisionShadows('task_role_shadow').ok).toBe(false);
  });
});
