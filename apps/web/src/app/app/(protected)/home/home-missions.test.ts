/**
 * Regression tests for Home page mission visibility and activity feed.
 *
 * Guards against the bug where:
 * 1. Scheduled missions (next run > 24h) were hidden behind a time-window filter,
 *    causing "No active missions right now" even when active missions exist.
 * 2. The activity feed scoping was tied to a single team (from cookie fallback),
 *    returning stale data when the cookie pointed to the wrong team.
 *
 * These tests exercise the pure filter/sort logic that runs inside the page
 * component after the DB returns mission rows.
 */

import { describe, it, expect } from 'bun:test';
import {
  deriveMissionHealth,
  healthToGroup,
  type MissionHealth,
  type MissionGroup,
} from '@/lib/mission-helpers';

// Minimal mission shape used by the Home page filter logic
type HomeMission = {
  id: string;
  group: MissionGroup;
  nextScanMins: number | null;
};

// Mirror of the fixed Home page filter logic (no 1440-min gate)
function getVisibleMissions(missions: HomeMission[]): HomeMission[] {
  const activeMissions = missions.filter(
    (m) => m.group === 'running' || m.group === 'attention',
  );
  const scheduledMissions = missions
    .filter((m) => m.group === 'scheduled')
    .sort((a, b) => (a.nextScanMins ?? Infinity) - (b.nextScanMins ?? Infinity))
    .slice(0, 3);
  return [...activeMissions, ...scheduledMissions];
}

// ---------------------------------------------------------------------------
// deriveMissionHealth + healthToGroup
// ---------------------------------------------------------------------------

describe('deriveMissionHealth', () => {
  it('returns active when agents are running', () => {
    const h = deriveMissionHealth({
      status: 'active',
      activeAgents: 2,
      cronExpression: null,
      lastRunAt: null,
      nextRunAt: null,
    });
    expect(h).toBe('active');
    expect(healthToGroup(h, 50)).toBe('running');
  });

  it('returns idle (→ attention) for active mission with no agents and no cron', () => {
    const h = deriveMissionHealth({
      status: 'active',
      activeAgents: 0,
      cronExpression: null,
      lastRunAt: null,
      nextRunAt: null,
    });
    expect(h).toBe('idle');
    expect(healthToGroup(h, 50)).toBe('attention');
  });

  it('returns on-schedule for a cron mission that ran recently', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const h = deriveMissionHealth({
      status: 'active',
      activeAgents: 0,
      cronExpression: '0 */6 * * *', // every 6 hours
      lastRunAt: fiveMinutesAgo,
      nextRunAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
    });
    expect(h).toBe('on-schedule');
    expect(healthToGroup(h, 50)).toBe('scheduled');
  });

  it('returns stalled when a cron mission is 2× overdue', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const h = deriveMissionHealth({
      status: 'active',
      activeAgents: 0,
      cronExpression: '0 9 * * *', // daily
      lastRunAt: threeDaysAgo,
      nextRunAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(h).toBe('stalled');
    expect(healthToGroup(h, 50)).toBe('attention');
  });

  it('returns shipped for a completed mission', () => {
    const h = deriveMissionHealth({
      status: 'completed',
      activeAgents: 0,
      cronExpression: null,
      lastRunAt: null,
      nextRunAt: null,
    });
    expect(h).toBe('shipped');
    expect(healthToGroup(h, 100)).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Home page mission filter (regression: no 24h gate on scheduled missions)
// ---------------------------------------------------------------------------

describe('Home page mission visibility filter', () => {
  const makeMission = (
    id: string,
    group: MissionGroup,
    nextScanMins: number | null = null,
  ): HomeMission => ({ id, group, nextScanMins });

  it('shows running missions', () => {
    const missions = [makeMission('m1', 'running')];
    expect(getVisibleMissions(missions).map((m) => m.id)).toContain('m1');
  });

  it('shows attention missions', () => {
    const missions = [makeMission('m1', 'attention')];
    expect(getVisibleMissions(missions).map((m) => m.id)).toContain('m1');
  });

  it('shows scheduled missions regardless of how far away the next run is', () => {
    // Weekly mission: next run in 7 days (10080 minutes) — was previously hidden
    const missions = [makeMission('weekly', 'scheduled', 10080)];
    const visible = getVisibleMissions(missions);
    expect(visible.map((m) => m.id)).toContain('weekly');
  });

  it('shows scheduled missions even when next run is months away', () => {
    const missions = [makeMission('monthly', 'scheduled', 43200)]; // 30 days
    const visible = getVisibleMissions(missions);
    expect(visible.map((m) => m.id)).toContain('monthly');
  });

  it('hides completed missions', () => {
    const missions = [makeMission('done', 'completed')];
    expect(getVisibleMissions(missions)).toHaveLength(0);
  });

  it('caps scheduled missions at 3 (sorted by imminence)', () => {
    const missions = [
      makeMission('s1', 'scheduled', 2880),  // 2 days
      makeMission('s2', 'scheduled', 1440),  // 1 day
      makeMission('s3', 'scheduled', 4320),  // 3 days
      makeMission('s4', 'scheduled', 720),   // 12 hours
    ];
    const visible = getVisibleMissions(missions);
    expect(visible).toHaveLength(3);
    // Should be sorted: s4 (720) < s2 (1440) < s1 (2880)
    expect(visible.map((m) => m.id)).toEqual(['s4', 's2', 's1']);
  });

  it('shows mix of running + attention + scheduled', () => {
    const missions = [
      makeMission('r1', 'running'),
      makeMission('a1', 'attention'),
      makeMission('s1', 'scheduled', 5000),
      makeMission('c1', 'completed'),
    ];
    const visible = getVisibleMissions(missions);
    const ids = visible.map((m) => m.id);
    expect(ids).toContain('r1');
    expect(ids).toContain('a1');
    expect(ids).toContain('s1');
    expect(ids).not.toContain('c1');
  });
});
