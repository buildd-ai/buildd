import { describe, expect, it } from 'bun:test';
import { QA_FIXTURE_MEMBER_ID, resolveTeamQaState, withQaFixtureMembers } from './qa-state';

const owner = {
  userId: 'u-owner',
  role: 'owner' as const,
  joinedAt: '2026-01-01T00:00:00.000Z',
  name: 'Owner',
  email: 'owner@example.com',
  image: null,
};

describe('resolveTeamQaState', () => {
  it('accepts multi-member on the dev server', () => {
    expect(resolveTeamQaState('multi-member', 'development')).toBe('multi-member');
    expect(resolveTeamQaState(['multi-member', 'x'], 'development')).toBe('multi-member');
  });

  it('ignores the param outside development', () => {
    expect(resolveTeamQaState('multi-member', 'production')).toBeNull();
    expect(resolveTeamQaState('multi-member', 'test')).toBeNull();
    expect(resolveTeamQaState('multi-member', undefined)).toBeNull();
  });

  it('ignores unknown or missing states', () => {
    expect(resolveTeamQaState(undefined, 'development')).toBeNull();
    expect(resolveTeamQaState('nope', 'development')).toBeNull();
  });
});

describe('withQaFixtureMembers', () => {
  it('leaves members untouched with no state', () => {
    expect(withQaFixtureMembers([owner], null)).toEqual([owner]);
  });

  it('adds one synthetic non-owner row for multi-member', () => {
    const rows = withQaFixtureMembers([owner], 'multi-member');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(owner);
    expect(rows[1].userId).toBe(QA_FIXTURE_MEMBER_ID);
    expect(rows[1].role).toBe('member');
  });

  it('does not add the row twice', () => {
    const once = withQaFixtureMembers([owner], 'multi-member');
    expect(withQaFixtureMembers(once, 'multi-member')).toHaveLength(2);
  });
});
