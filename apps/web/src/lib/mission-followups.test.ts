import { describe, it, expect } from 'bun:test';
import { matchMissionFollowups, type FollowupCandidateRow } from './mission-followups';

describe('matchMissionFollowups', () => {
  const MISSION_ID = 'mission-1';
  const OTHER_MISSION_ID = 'mission-2';
  const COMPLETED_AT = '2025-01-05T00:00:00Z';

  it('matches a row by missionId', () => {
    const rows: FollowupCandidateRow[] = [
      { id: 't1', createdAt: '2025-01-06T00:00:00Z', missionId: MISSION_ID, parentTaskId: null, context: null },
    ];
    const result = matchMissionFollowups(rows, [{ id: MISSION_ID, completedAt: COMPLETED_AT, taskIds: [] }]);
    expect(result.get(MISSION_ID)?.map(t => t.id)).toEqual(['t1']);
  });

  it('matches a row by parentTaskId onto one of the mission\'s own tasks', () => {
    const rows: FollowupCandidateRow[] = [
      { id: 't1', createdAt: '2025-01-06T00:00:00Z', missionId: null, parentTaskId: 'parent-task', context: null },
    ];
    const result = matchMissionFollowups(rows, [{ id: MISSION_ID, completedAt: COMPLETED_AT, taskIds: ['parent-task'] }]);
    expect(result.get(MISSION_ID)?.map(t => t.id)).toEqual(['t1']);
  });

  it('matches a row by a failureContext mention of the mission id', () => {
    const rows: FollowupCandidateRow[] = [
      { id: 't1', createdAt: '2025-01-06T00:00:00Z', missionId: null, parentTaskId: null, context: { failureContext: `see mission ${MISSION_ID}` } },
    ];
    const result = matchMissionFollowups(rows, [{ id: MISSION_ID, completedAt: COMPLETED_AT, taskIds: [] }]);
    expect(result.get(MISSION_ID)?.map(t => t.id)).toEqual(['t1']);
  });

  it('excludes a row created before this mission completed', () => {
    const rows: FollowupCandidateRow[] = [
      { id: 't1', createdAt: '2025-01-04T00:00:00Z', missionId: MISSION_ID, parentTaskId: null, context: null },
    ];
    const result = matchMissionFollowups(rows, [{ id: MISSION_ID, completedAt: COMPLETED_AT, taskIds: [] }]);
    expect(result.get(MISSION_ID)).toEqual([]);
  });

  it('excludes a row created before completion for one mission but keeps it as a follow-up for another', () => {
    const rows: FollowupCandidateRow[] = [
      { id: 't1', createdAt: '2025-01-06T00:00:00Z', missionId: OTHER_MISSION_ID, parentTaskId: null, context: null },
    ];
    const missions = [
      { id: MISSION_ID, completedAt: COMPLETED_AT, taskIds: [] },
      { id: OTHER_MISSION_ID, completedAt: '2025-01-01T00:00:00Z', taskIds: [] },
    ];
    const result = matchMissionFollowups(rows, missions);
    expect(result.get(MISSION_ID)).toEqual([]);
    expect(result.get(OTHER_MISSION_ID)?.map(t => t.id)).toEqual(['t1']);
  });

  it('does not match a row with no reference to the mission at all', () => {
    const rows: FollowupCandidateRow[] = [
      { id: 't1', createdAt: '2025-01-06T00:00:00Z', missionId: OTHER_MISSION_ID, parentTaskId: 'unrelated-parent', context: { summary: 'unrelated' } },
    ];
    const result = matchMissionFollowups(rows, [{ id: MISSION_ID, completedAt: COMPLETED_AT, taskIds: ['some-task'] }]);
    expect(result.get(MISSION_ID)).toEqual([]);
  });

  it('returns an empty array for every scored mission, even with no matching rows', () => {
    const result = matchMissionFollowups([], [{ id: MISSION_ID, completedAt: COMPLETED_AT, taskIds: [] }]);
    expect(result.get(MISSION_ID)).toEqual([]);
  });
});
