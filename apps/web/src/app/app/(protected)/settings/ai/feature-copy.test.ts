import { describe, it, expect } from 'bun:test';
import * as copy from './feature-copy';
import { defaultLine, featureState, modeLabel, OVERRIDE_OPTIONS } from './feature-copy';

describe('AI features copy', () => {
  it('states the default from the billing model', () => {
    expect(defaultLine(true)).toBe('Default: server-side (team key)');
    expect(defaultLine(false)).toBe('Default: runner (no team key)');
  });

  it('labels a feature row with where it runs, and marks an override', () => {
    expect(featureState({ mode: 'server', source: 'default', needsKey: false })).toBe('Server-side');
    expect(featureState({ mode: 'runner', source: 'default', needsKey: false })).toBe('Runner');
    expect(featureState({ mode: 'runner', source: 'override', needsKey: false })).toBe('Runner · override');
    expect(featureState({ mode: 'server', source: 'override', needsKey: true })).toBe('Server-side · needs a team key');
  });

  it('offers Default, Server-side and Runner as overrides', () => {
    expect(OVERRIDE_OPTIONS.map((o) => o.label)).toEqual(['Default', 'Server-side', 'Runner']);
    expect(modeLabel('server')).toBe('Server-side');
  });

  it('has no interactive on/off state: chat is always on', () => {
    expect((copy as Record<string, unknown>).interactiveState).toBeUndefined();
  });

  it('the default line stays a label', () => {
    for (const s of [defaultLine(true), defaultLine(false)]) {
      expect(s.toLowerCase()).not.toContain('chat');
      expect(s.length).toBeLessThanOrEqual(40);
    }
  });
});
