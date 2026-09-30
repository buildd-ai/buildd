import { describe, expect, it } from 'bun:test';
import { groupRunnerTokens } from './runner-token-groups';

const t = (id: string, team: string | null, createdAt: string, lastSeenAt: string | null = null) =>
  ({ id, team: team ? { name: team } : null, createdAt, lastSeenAt });

describe('groupRunnerTokens', () => {
  it('groups by team, newest token first, newest group first', () => {
    const groups = groupRunnerTokens([
      t('a1', 'Team A', '2026-01-01T00:00:00Z'),
      t('b1', 'Team B', '2026-03-01T00:00:00Z'),
      t('a2', 'Team A', '2026-02-01T00:00:00Z'),
      t('n1', null, '2025-12-01T00:00:00Z'),
    ]);
    expect(groups.map(g => g.team)).toEqual(['Team B', 'Team A', 'No team']);
    expect(groups[1].tokens.map(x => x.id)).toEqual(['a2', 'a1']);
  });

  it("carries the group's most recent last-seen", () => {
    const [g] = groupRunnerTokens([
      t('a1', 'Team A', '2026-01-01T00:00:00Z', '2026-09-01T10:00:00Z'),
      t('a2', 'Team A', '2026-02-01T00:00:00Z', '2026-09-01T12:00:00Z'),
      t('a3', 'Team A', '2026-03-01T00:00:00Z'),
    ]);
    expect(g.lastSeenAt).toBe('2026-09-01T12:00:00Z');
  });
});
