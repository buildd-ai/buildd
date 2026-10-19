import { describe, expect, it } from 'bun:test';
import { missionReadOptions, missionSummaryResponse } from './mission-read-shape';

describe('bounded mission reads', () => {
  it('defaults to summary and bounds explicit detail task reads', () => {
    expect(missionReadOptions(new URLSearchParams())).toEqual({ details: false, limit: 50 });
    expect(missionReadOptions(new URLSearchParams('include=details&limit=10000'))).toEqual({ details: true, limit: 100 });
    expect(missionReadOptions(new URLSearchParams('limit=-1'))).toEqual({ details: false, limit: 50 });
  });
  it('never carries task results, workspace config or mission JSON into a summary', () => {
    const row = { id: 'm', title: 'Mission', status: 'active', tasks: [{ result: { secret: true } }], workspace: { gitConfig: {} }, description: 'large', goalCriteria: [{}] };
    const summary = { progress: { total: 4, done: 2, percent: 50 }, liveWorkers: 1, lastActivityAt: 'today' } as any;
    const out = missionSummaryResponse(row, summary);
    expect(out).toMatchObject({ id: 'm', totalTasks: 4, completedTasks: 2, progress: 50, activeAgents: 1, summary });
    for (const key of ['tasks', 'workspace', 'description', 'goalCriteria']) expect(out).not.toHaveProperty(key);
  });
});
