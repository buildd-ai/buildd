import { describe, it, expect } from 'bun:test';
import { defaultTeamId, parseActiveTeamCookie } from './active-team-client';

// Illustrative fixtures only.
const teams = [
  { id: 'team-personal', slug: 'personal-someone' },
  { id: 'team-work', slug: 'work' },
];

describe('defaultTeamId', () => {
  it('prefers the active team over Personal', () => {
    expect(defaultTeamId(teams, 'team-work')).toBe('team-work');
  });

  it('falls back to Personal when no team is active', () => {
    expect(defaultTeamId(teams, null)).toBe('team-personal');
  });

  it('ignores an active id the user is not a member of', () => {
    expect(defaultTeamId(teams, 'team-gone')).toBe('team-personal');
  });

  it('falls back to the first team, then to empty', () => {
    expect(defaultTeamId([{ id: 'only', slug: 'only' }], null)).toBe('only');
    expect(defaultTeamId([], 'team-work')).toBe('');
  });
});

describe('parseActiveTeamCookie', () => {
  it('reads buildd-team from a cookie header string', () => {
    expect(parseActiveTeamCookie('a=1; buildd-team=team-work; b=2')).toBe('team-work');
    expect(parseActiveTeamCookie('buildd-team=team%2Dwork')).toBe('team-work');
  });

  it('returns null for a malformed percent-encoding instead of throwing', () => {
    expect(() => parseActiveTeamCookie('buildd-team=%E0%A4%A')).not.toThrow();
    expect(parseActiveTeamCookie('buildd-team=%E0%A4%A')).toBeNull();
  });

  it('returns null when absent, and does not match a longer cookie name', () => {
    expect(parseActiveTeamCookie('')).toBeNull();
    expect(parseActiveTeamCookie('not-buildd-team=x')).toBeNull();
  });
});
