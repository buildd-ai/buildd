import { describe, it, expect } from 'bun:test';
import {
  INFERENCE_CAPABILITIES,
  ALL_INFERENCE_CAPABILITIES,
  SERVER_FEATURES,
  LIVE_SERVER_FEATURES,
  isInferenceCapability,
  isInferenceAllowed,
  normalizeFeatureModes,
  resolveFeatureMode,
} from '../inference-policy';

/**
 * Which calls may spend a provider key. Three kinds:
 * - interactive (chat): on whenever a key resolves; the admin's kill switch is `chatDisabled`.
 * - built-in decision calls: always allowed; they run when a key resolves.
 * - server-side features: default by billing model, per-feature override `runner`.
 */

describe('isInferenceAllowed', () => {
  it('allows every capability on a team that never touched a setting', () => {
    for (const c of ALL_INFERENCE_CAPABILITIES) {
      expect(isInferenceAllowed(c, { chatDisabled: false, featureModes: null })).toBe(true);
    }
  });

  it('never gates the built-in decision calls', () => {
    const gate = { chatDisabled: true, featureModes: { task_classification: 'runner', task_category_shadow: 'runner' } };
    expect(isInferenceAllowed('task_classification', gate)).toBe(true);
    expect(isInferenceAllowed('task_category_shadow', gate)).toBe(true);
  });

  it('stops chat, and only chat, when an admin switches it off', () => {
    const gate = { chatDisabled: true, featureModes: null };
    expect(isInferenceAllowed('chat', gate)).toBe(false);
    expect(isInferenceAllowed('criteria_grading', gate)).toBe(true);
  });

  it('sends a server-side feature to the runner when overridden', () => {
    const gate = { chatDisabled: false, featureModes: { visual_qa: 'runner' } };
    expect(isInferenceAllowed('visual_qa', gate)).toBe(false);
    expect(isInferenceAllowed('criteria_grading', gate)).toBe(true);
    expect(isInferenceAllowed('mission_summary', gate)).toBe(true);
  });

  it('fails closed on a missing team row', () => {
    for (const c of ALL_INFERENCE_CAPABILITIES) expect(isInferenceAllowed(c, null)).toBe(false);
  });

  it('ignores garbage in the stored modes', () => {
    expect(isInferenceAllowed('criteria_grading', { chatDisabled: false, featureModes: 'runner' })).toBe(true);
    expect(isInferenceAllowed('criteria_grading', { chatDisabled: false, featureModes: { criteria_grading: 'off' } })).toBe(true);
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
    expect([...LIVE_SERVER_FEATURES]).toEqual(['criteria_grading']);
    for (const f of LIVE_SERVER_FEATURES) expect(SERVER_FEATURES).toContain(f);
  });

  it('classifies every capability', () => {
    expect([...SERVER_FEATURES]).toEqual(['criteria_grading', 'visual_qa', 'mission_summary']);
    for (const f of SERVER_FEATURES) expect(INFERENCE_CAPABILITIES[f].kind).toBe('server_feature');
    expect(INFERENCE_CAPABILITIES.chat.kind).toBe('interactive');
    expect(INFERENCE_CAPABILITIES.task_classification.kind).toBe('built_in');
    expect(INFERENCE_CAPABILITIES.task_category_shadow.kind).toBe('built_in');
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
