import { describe, it, expect } from 'bun:test';
import { incidentStateLine, incidentAffected } from './incident-view';

describe('incident page words', () => {
  const now = new Date('2026-10-09T23:00:00Z');
  it('says severity, status and how often in one line', () => {
    expect(incidentStateLine({ severity: 'critical', status: 'open', occurrenceCount: 14, recurrenceCount: 0, firstSeenAt: new Date('2026-10-09T20:00:00Z') }, now))
      .toBe('Critical · Open · seen 14 times since 3h ago');
    expect(incidentStateLine({ severity: 'high', status: 'acknowledged', occurrenceCount: 1, recurrenceCount: 2, firstSeenAt: new Date('2026-10-09T22:30:00Z') }, now))
      .toBe('High · Acknowledged · seen once since 30m ago · came back 2 times');
  });
  it('lists affected tasks and PRs as links, at most 10 of each', () => {
    const a = incidentAffected({ taskIds: Array.from({ length: 12 }, (_, i) => `t${i}`), workerIds: [], prNumbers: [7] });
    expect(a.tasks).toHaveLength(10);
    expect(a.tasks[0]).toEqual({ label: 'Task t0', href: '/app/tasks/t0' });
    expect(a.moreTasks).toBe(2);
    expect(a.prs).toEqual([{ label: 'PR #7' }]);
  });
});
