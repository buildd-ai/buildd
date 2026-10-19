import { describe, it, expect } from 'bun:test';
import { classifyRunnerOwnership } from './runner-ownership';

describe('classifyRunnerOwnership', () => {
  it('a personal runner stays personal whichever team is viewed: the input carries no team', () => {
    const account = { createdByUserId: 'user-a' };
    // Same account, as seen from its home team and from another team it was selected into.
    expect(classifyRunnerOwnership(account)).toBe('personal');
    expect(classifyRunnerOwnership({ ...account, managedRunner: false, hostRunner: false })).toBe('personal');
  });

  it('managed and team-host flags win over a recorded creator', () => {
    expect(classifyRunnerOwnership({ managedRunner: true, hostRunner: true, createdByUserId: 'u' })).toBe('managed');
    expect(classifyRunnerOwnership({ hostRunner: true, createdByUserId: 'u' })).toBe('team');
  });

  it('missing ownership is unknown, never guessed as personal or managed', () => {
    expect(classifyRunnerOwnership(null)).toBe('unknown');
    expect(classifyRunnerOwnership(undefined)).toBe('unknown');
    expect(classifyRunnerOwnership({})).toBe('unknown');
    expect(classifyRunnerOwnership({ managedRunner: false, hostRunner: null, createdByUserId: null })).toBe('unknown');
  });
});
