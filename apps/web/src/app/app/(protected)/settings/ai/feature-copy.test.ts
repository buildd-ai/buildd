import { describe, it, expect } from 'bun:test';
import * as copy from './feature-copy';
import { defaultLine, featureState, modeLabel, OVERRIDE_OPTIONS } from './feature-copy';

describe('AI features copy', () => {
  it('states what Auto resolves to, from the billing model', () => {
    expect(defaultLine(true)).toBe('Auto: server (team key)');
    expect(defaultLine(false)).toBe('Auto: runner (no team key)');
  });

  it('labels a feature row with where it runs, and marks an override', () => {
    expect(featureState({ mode: 'server', source: 'default', needsKey: false })).toBe('Server');
    expect(featureState({ mode: 'runner', source: 'default', needsKey: false })).toBe('Runner');
    expect(featureState({ mode: 'runner', source: 'override', needsKey: false })).toBe('Runner · override');
    expect(featureState({ mode: 'server', source: 'override', needsKey: true })).toBe('Server · needs a team key');
  });

  it('offers Auto, Server and Runner', () => {
    expect(OVERRIDE_OPTIONS.map((o) => o.label)).toEqual(['Auto', 'Server', 'Runner']);
    expect(modeLabel('server')).toBe('Server');
  });

  it('has no interactive on/off state: chat is always on', () => {
    expect((copy as Record<string, unknown>).interactiveState).toBeUndefined();
  });

  it('the default line stays a label and says "server-side" nowhere', () => {
    for (const s of [defaultLine(true), defaultLine(false)]) {
      expect(s.toLowerCase()).not.toContain('chat');
      expect(s.toLowerCase()).not.toContain('server-side');
      expect(s.length).toBeLessThanOrEqual(40);
    }
  });
});
