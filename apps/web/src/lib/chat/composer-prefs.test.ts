import { describe, expect, it } from 'bun:test';
import { parseComposerPrefs, parseTeamDefaultTier, resolveInitialTier, seedComposer } from './composer-prefs';

describe('resolveInitialTier', () => {
  it('cap off: the person\'s last tier, whatever the team default', () => {
    expect(resolveInitialTier({ userPref: 'premium', teamDefault: 'budget', capEnabled: false })).toBe('premium');
    expect(resolveInitialTier({ userPref: null, teamDefault: 'budget', capEnabled: false })).toBeNull();
  });

  it('cap on: a last tier above the default resets down to it', () => {
    expect(resolveInitialTier({ userPref: 'premium', teamDefault: 'standard', capEnabled: true })).toBe('standard');
  });

  it('cap on: a last tier at or below the default is kept (never up)', () => {
    expect(resolveInitialTier({ userPref: 'budget', teamDefault: 'standard', capEnabled: true })).toBe('budget');
    expect(resolveInitialTier({ userPref: 'standard', teamDefault: 'standard', capEnabled: true })).toBe('standard');
  });

  it('cap on, team default auto: no cap, the last pick stands', () => {
    expect(resolveInitialTier({ userPref: 'premium', teamDefault: null, capEnabled: true })).toBe('premium');
  });

  it('cap on: a person on auto starts at the team default (auto is uncapped)', () => {
    expect(resolveInitialTier({ userPref: null, teamDefault: 'standard', capEnabled: true })).toBe('standard');
  });

  it('never picked: auto, unless the cap sets it', () => {
    expect(resolveInitialTier({ userPref: undefined, teamDefault: 'budget', capEnabled: false })).toBeNull();
    expect(resolveInitialTier({ userPref: undefined, teamDefault: 'budget', capEnabled: true })).toBe('budget');
  });
});

describe('parseComposerPrefs', () => {
  it('keeps a null choice apart from no choice', () => {
    expect(parseComposerPrefs({ workspaceId: null, tier: null })).toEqual({ workspaceId: null, tier: null });
    expect(parseComposerPrefs({})).toEqual({});
    expect(parseComposerPrefs(null)).toEqual({});
  });

  it('drops values this build does not know', () => {
    expect(parseComposerPrefs({ workspaceId: 7, tier: 'premium-plus' })).toEqual({});
    expect(parseComposerPrefs('x')).toEqual({});
  });
});

describe('parseTeamDefaultTier', () => {
  it('a chat tier, else auto', () => {
    expect(parseTeamDefaultTier('standard')).toBe('standard');
    expect(parseTeamDefaultTier('premium-plus')).toBeNull();
    expect(parseTeamDefaultTier(null)).toBeNull();
  });
});

describe('seedComposer', () => {
  const team = { teamDefault: 'standard' as const, capEnabled: true };

  it('a remembered workspace still in the team seeds it', () => {
    expect(seedComposer({ workspaceId: 'ws-1', tier: 'premium' }, team, ['ws-1'])).toEqual({ workspaceId: 'ws-1', tier: 'standard' });
  });

  it('a workspace the person can no longer see falls back to the page default', () => {
    expect(seedComposer({ workspaceId: 'gone' }, team, ['ws-1'])).toEqual({ tier: 'standard' });
  });

  it('all workspaces is remembered as a choice', () => {
    expect(seedComposer({ workspaceId: null }, { teamDefault: null, capEnabled: false }, [])).toEqual({ workspaceId: null, tier: null });
  });
});
