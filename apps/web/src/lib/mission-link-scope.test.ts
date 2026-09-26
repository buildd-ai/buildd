import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockMissionsFindFirst = mock(() => Promise.resolve(null as any));

mock.module('@buildd/core/db', () => ({
  db: { query: { missions: { findFirst: mockMissionsFindFirst } } },
}));

import { isMissionLinkable } from './mission-link-scope';

describe('isMissionLinkable', () => {
  beforeEach(() => {
    mockMissionsFindFirst.mockReset();
    mockMissionsFindFirst.mockResolvedValue(null);
  });

  it('allows a mission owned by the same team', async () => {
    mockMissionsFindFirst.mockResolvedValue({ teamId: 'team-1' });
    expect(await isMissionLinkable('mission-1', 'team-1')).toBe(true);
  });

  it("refuses another team's mission", async () => {
    mockMissionsFindFirst.mockResolvedValue({ teamId: 'team-2' });
    expect(await isMissionLinkable('mission-1', 'team-1')).toBe(false);
  });

  it('refuses a mission that does not exist', async () => {
    expect(await isMissionLinkable('mission-1', 'team-1')).toBe(false);
  });

  it('refuses when the task has no team, without querying', async () => {
    mockMissionsFindFirst.mockResolvedValue({ teamId: null });
    expect(await isMissionLinkable('mission-1', null)).toBe(false);
    expect(await isMissionLinkable('mission-1', undefined)).toBe(false);
    expect(mockMissionsFindFirst).not.toHaveBeenCalled();
  });

  it('refuses non-string and empty ids without querying', async () => {
    for (const id of [undefined, null, '', 42, {}]) {
      expect(await isMissionLinkable(id, 'team-1')).toBe(false);
    }
    expect(mockMissionsFindFirst).not.toHaveBeenCalled();
  });
});
