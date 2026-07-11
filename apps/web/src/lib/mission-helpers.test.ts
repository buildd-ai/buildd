import { describe, it, expect } from 'bun:test';
import {
  healthToGroup,
  deriveMissionHealth,
  FILTER_TO_GROUPS,
  GROUP_ORDER,
  type MissionHealth,
  type MissionGroup,
  type FilterTab,
} from './mission-helpers';

describe('healthToGroup — status taxonomy', () => {
  it('paused maps to paused group, never completed', () => {
    expect(healthToGroup('paused', 0)).toBe('paused');
    expect(healthToGroup('paused', 50)).toBe('paused');
    expect(healthToGroup('paused', 100)).toBe('paused');
    expect(healthToGroup('paused', 0)).not.toBe('completed');
  });

  it('shipped maps to completed', () => {
    expect(healthToGroup('shipped', 100)).toBe('completed');
  });

  it('active maps to running', () => {
    expect(healthToGroup('active', 0)).toBe('running');
  });

  it('stalled maps to attention', () => {
    expect(healthToGroup('stalled', 0)).toBe('attention');
  });

  it('on-schedule maps to scheduled', () => {
    expect(healthToGroup('on-schedule', 0)).toBe('scheduled');
  });

  it('idle with 100% progress maps to review', () => {
    expect(healthToGroup('idle', 100)).toBe('review');
  });

  it('idle with <100% progress maps to attention', () => {
    expect(healthToGroup('idle', 0)).toBe('attention');
    expect(healthToGroup('idle', 99)).toBe('attention');
  });

  it('every health value maps to exactly one group', () => {
    const healthValues: MissionHealth[] = ['active', 'on-schedule', 'stalled', 'shipped', 'paused', 'idle'];
    const groupValues = healthValues.map(h => healthToGroup(h, 0));
    // Each maps to a defined group
    for (const g of groupValues) {
      expect(GROUP_ORDER).toContain(g);
    }
  });
});

describe('FILTER_TO_GROUPS invariants', () => {
  it('paused is NOT in the completed tab groups', () => {
    const completedGroups = FILTER_TO_GROUPS.completed ?? [];
    expect(completedGroups).not.toContain('paused');
  });

  it('paused group is not in active tab groups', () => {
    const activeGroups = FILTER_TO_GROUPS.active ?? [];
    expect(activeGroups).not.toContain('paused');
  });

  it('paused group appears in GROUP_ORDER', () => {
    expect(GROUP_ORDER).toContain('paused');
  });

  it('every non-null tab group is a valid MissionGroup in GROUP_ORDER', () => {
    const tabs: FilterTab[] = ['active', 'scheduled', 'completed'];
    for (const tab of tabs) {
      const groups = FILTER_TO_GROUPS[tab];
      if (groups) {
        for (const g of groups) {
          expect(GROUP_ORDER).toContain(g);
        }
      }
    }
  });
});

describe('deriveMissionHealth — paused status', () => {
  it('status=paused always returns paused health regardless of agents or schedule', () => {
    expect(deriveMissionHealth({ status: 'paused', activeAgents: 0, cronExpression: null, lastRunAt: null, nextRunAt: null })).toBe('paused');
    expect(deriveMissionHealth({ status: 'paused', activeAgents: 3, cronExpression: '0 * * * *', lastRunAt: null, nextRunAt: null })).toBe('paused');
  });

  it('status=completed returns shipped', () => {
    expect(deriveMissionHealth({ status: 'completed', activeAgents: 0, cronExpression: null, lastRunAt: null, nextRunAt: null })).toBe('shipped');
  });
});

describe('tab count reconciliation', () => {
  it('paused missions are counted in "all" but not in "completed" group', () => {
    // Simulate a bucket of missions: 1 paused, 1 shipped, 1 active
    const missions = [
      { health: 'paused' as MissionHealth, progress: 0 },
      { health: 'shipped' as MissionHealth, progress: 100 },
      { health: 'active' as MissionHealth, progress: 50 },
    ];

    const groups: Record<MissionGroup, number> = {
      running: 0, attention: 0, review: 0, scheduled: 0, paused: 0, completed: 0,
    };
    for (const m of missions) {
      groups[healthToGroup(m.health, m.progress)]++;
    }

    // paused mission lands in 'paused', not 'completed'
    expect(groups.paused).toBe(1);
    expect(groups.completed).toBe(1); // only the shipped mission
    expect(groups.running).toBe(1);

    // Sum of all groups equals total
    const sum = Object.values(groups).reduce((a, b) => a + b, 0);
    expect(sum).toBe(missions.length);

    // Completed tab count (groups in FILTER_TO_GROUPS.completed) does not include paused
    const completedTabCount = (FILTER_TO_GROUPS.completed ?? []).reduce((s, g) => s + groups[g], 0);
    expect(completedTabCount).toBe(1); // only shipped
  });
});
