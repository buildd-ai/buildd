import { describe, it, expect } from 'bun:test';
import { ALL_INFERENCE_CAPABILITIES, INFERENCE_CAPABILITIES } from '@buildd/core/inference-policy';
import { capabilityToggleCopy, FEATURE_TRADEOFF } from './feature-copy';

const EM_DASH = '—';

describe('capabilityToggleCopy', () => {
  const chat = INFERENCE_CAPABILITIES.chat;
  const grading = INFERENCE_CAPABILITIES.criteria_grading;

  it('labels chat as a plain on/off switch', () => {
    expect(capabilityToggleCopy(chat, false).button).toBe('Turn on chat');
    expect(capabilityToggleCopy(chat, true).button).toBe('Turn off chat');
    expect(capabilityToggleCopy(chat, false).meta).toBe('off');
    expect(capabilityToggleCopy(chat, true).meta).toBe(`on · ${chat.costHint}`);
  });

  it('tells you chat needs a provider key, since the switch alone spends nothing', () => {
    expect(capabilityToggleCopy(chat, true).needsKeyHint).toBe(true);
    expect(capabilityToggleCopy(grading, true).needsKeyHint).toBe(false);
  });

  it('names the action on each button instead of a generic "Use inference"', () => {
    const labels = ALL_INFERENCE_CAPABILITIES.map((c) => capabilityToggleCopy(INFERENCE_CAPABILITIES[c], false).button);
    expect(new Set(labels).size).toBe(labels.length);
    for (const l of labels) {
      expect(l).not.toBe('Use inference');
      expect(l).not.toBe('Use agent');
    }
    expect(capabilityToggleCopy(grading, false).button).toBe('Grade with a model');
    expect(capabilityToggleCopy(grading, true).button).toBe('Grade with an agent run');
  });

  it('says what happens when a feature is off, once, in the meta line', () => {
    expect(capabilityToggleCopy(grading, false).meta).toBe('off · an agent run grades instead');
    expect(capabilityToggleCopy(INFERENCE_CAPABILITIES.visual_qa, false).meta).toBe('off');
  });

  it('writes result messages in active voice, no em dashes', () => {
    for (const c of ALL_INFERENCE_CAPABILITIES) {
      const d = INFERENCE_CAPABILITIES[c];
      for (const on of [true, false]) {
        const copy = capabilityToggleCopy(d, on);
        for (const m of [copy.button, copy.meta, copy.turnedOn, copy.turnedOff]) expect(m).not.toContain(EM_DASH);
      }
    }
    expect(capabilityToggleCopy(chat, false).turnedOn).toMatch(/Chat is on/);
    expect(capabilityToggleCopy(grading, true).turnedOff).toMatch(/agent run/);
  });

  it('states the tradeoff once, without jargon', () => {
    expect(FEATURE_TRADEOFF).not.toContain(EM_DASH);
    expect(FEATURE_TRADEOFF).not.toMatch(/inference|decision key/i);
  });
});

describe('capability descriptions (shown on the AI page)', () => {
  it('carry no em dashes or internal jargon', () => {
    for (const c of ALL_INFERENCE_CAPABILITIES) {
      const d = INFERENCE_CAPABILITIES[c];
      expect(d.description).not.toContain(EM_DASH);
      expect(d.description).not.toMatch(/decision key|decision model|multimodal/i);
    }
  });
});
