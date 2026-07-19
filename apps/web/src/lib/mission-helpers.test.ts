import { describe, it, expect } from 'bun:test';
import {
  healthToGroup,
  deriveMissionHealth,
  deriveDriveState,
  deriveHealth,
  FILTER_TO_GROUPS,
  GROUP_ORDER,
  HEALTH_DISPLAY,
  type MissionHealth,
  type MissionGroup,
  type FilterTab,
  type DriveState,
  type Health,
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

// ── objectives contract ───────────────────────────────────────────────────────
// The dispatch UI consumes deriveMissionHealth via /api/buildd/objectives.
// These exports must remain stable.

describe('objectives contract — deriveMissionHealth export unchanged', () => {
  const EXPECTED_HEALTH_VALUES: MissionHealth[] = ['active', 'on-schedule', 'stalled', 'shipped', 'paused', 'idle'];

  it('all original MissionHealth values still produce valid HEALTH_DISPLAY entries', () => {
    for (const v of EXPECTED_HEALTH_VALUES) {
      expect(HEALTH_DISPLAY[v]).toBeDefined();
      expect(HEALTH_DISPLAY[v].label).toBeTruthy();
    }
  });

  it('deriveMissionHealth returns one of the original four conceptual outcomes', () => {
    const active = deriveMissionHealth({ status: 'active', activeAgents: 1, cronExpression: null, lastRunAt: null, nextRunAt: null });
    expect(active).toBe('active');

    const shipped = deriveMissionHealth({ status: 'completed', activeAgents: 0, cronExpression: null, lastRunAt: null, nextRunAt: null });
    expect(shipped).toBe('shipped');

    const onSchedule = deriveMissionHealth({ status: 'active', activeAgents: 0, cronExpression: '0 * * * *', lastRunAt: new Date(Date.now() - 30 * 60_000).toISOString(), nextRunAt: null });
    expect(onSchedule).toBe('on-schedule');

    const idle = deriveMissionHealth({ status: 'active', activeAgents: 0, cronExpression: null, lastRunAt: null, nextRunAt: null });
    expect(idle).toBe('idle');
  });

  it('all health values map to a known group — no new values silently added', () => {
    for (const h of EXPECTED_HEALTH_VALUES) {
      const group = healthToGroup(h, 50);
      expect(GROUP_ORDER).toContain(group);
    }
  });
});

// ── deriveDriveState ──────────────────────────────────────────────────────────

describe('deriveDriveState', () => {
  const base = { status: 'active', orchestrationMode: 'auto' as string, lastDeferralReason: null, lastDeferredAt: null };

  it('COMPLETE when status is completed', () => {
    expect(deriveDriveState({ ...base, status: 'completed' })).toBe<DriveState>('COMPLETE');
  });

  it('COMPLETE when status is archived', () => {
    expect(deriveDriveState({ ...base, status: 'archived' })).toBe<DriveState>('COMPLETE');
  });

  it('MANUAL when orchestrationMode is manual', () => {
    expect(deriveDriveState({ ...base, orchestrationMode: 'manual' })).toBe<DriveState>('MANUAL');
  });

  it('MANUAL takes priority over deferral state', () => {
    expect(deriveDriveState({
      status: 'active',
      orchestrationMode: 'manual',
      lastDeferralReason: 'concurrent_cap',
      lastDeferredAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    })).toBe<DriveState>('MANUAL');
  });

  it('AUTO for an active auto mission with no deferral', () => {
    expect(deriveDriveState(base)).toBe<DriveState>('AUTO');
  });

  it('QUIET_HOURS when active_hours deferral is recent (<2h)', () => {
    expect(deriveDriveState({
      ...base,
      lastDeferralReason: 'active_hours',
      lastDeferredAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    })).toBe<DriveState>('QUIET_HOURS');
  });

  it('SEATS_FULL when concurrent_cap deferral is recent (<2h)', () => {
    expect(deriveDriveState({
      ...base,
      lastDeferralReason: 'concurrent_cap',
      lastDeferredAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    })).toBe<DriveState>('SEATS_FULL');
  });

  it('AUTO when deferral is stale (>2h ago)', () => {
    expect(deriveDriveState({
      ...base,
      lastDeferralReason: 'active_hours',
      lastDeferredAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    })).toBe<DriveState>('AUTO');
  });

  it('AUTO when lastDeferredAt is null but reason is set', () => {
    expect(deriveDriveState({ ...base, lastDeferralReason: 'active_hours', lastDeferredAt: null })).toBe<DriveState>('AUTO');
  });
});

// ── deriveHealth ──────────────────────────────────────────────────────────────

describe('deriveHealth', () => {
  const noDepMission = { dependsOnMissionId: null, dependencyMetAt: null };

  function makeTask(status: string, workers?: Array<{ status: string }>) {
    return { status, title: 'Do work', workers };
  }

  it('NOMINAL when all tasks completed and no dependency', () => {
    expect(deriveHealth(noDepMission, [makeTask('completed')])).toBe<Health>('NOMINAL');
  });

  it('NOMINAL when task list is empty', () => {
    expect(deriveHealth(noDepMission, [])).toBe<Health>('NOMINAL');
  });

  it('BLOCKED when mission has unsatisfied dependency', () => {
    expect(deriveHealth(
      { dependsOnMissionId: 'upstream-id', dependencyMetAt: null },
      [makeTask('completed')],
    )).toBe<Health>('BLOCKED');
  });

  it('BLOCKED even when tasks are failing — dependency takes priority', () => {
    expect(deriveHealth(
      { dependsOnMissionId: 'upstream-id', dependencyMetAt: null },
      [makeTask('failed')],
    )).toBe<Health>('BLOCKED');
  });

  it('not BLOCKED when dependency is already met', () => {
    expect(deriveHealth(
      { dependsOnMissionId: 'upstream-id', dependencyMetAt: new Date() },
      [makeTask('completed')],
    )).toBe<Health>('NOMINAL');
  });

  it('FAILING when a deliverable task has status failed', () => {
    expect(deriveHealth(noDepMission, [
      makeTask('completed'),
      makeTask('failed'),
    ])).toBe<Health>('FAILING');
  });

  it('FAILING ignores cancelled tasks', () => {
    expect(deriveHealth(noDepMission, [
      makeTask('cancelled'),
      makeTask('failed'),
    ])).toBe<Health>('FAILING');
  });

  it('STALLED when deliverable pending task has no live worker', () => {
    expect(deriveHealth(noDepMission, [makeTask('pending', [])])).toBe<Health>('STALLED');
  });

  it('not STALLED when pending task has a running worker', () => {
    expect(deriveHealth(noDepMission, [makeTask('pending', [{ status: 'running' }])])).toBe<Health>('NOMINAL');
  });

  it('not STALLED when pending task has a waiting_input worker', () => {
    expect(deriveHealth(noDepMission, [makeTask('pending', [{ status: 'waiting_input' }])])).toBe<Health>('NOMINAL');
  });

  it('coordination tasks excluded from health assessment', () => {
    const coordTask = { status: 'pending', kind: 'coordination' as const, title: 'Coordinate', workers: [] };
    expect(deriveHealth(noDepMission, [coordTask])).toBe<Health>('NOMINAL');
  });

  it('manual+healthy mission — MANUAL drive, NOMINAL health (distinguishable)', () => {
    const drive = deriveDriveState({ status: 'active', orchestrationMode: 'manual' });
    const health = deriveHealth(noDepMission, [makeTask('completed')]);
    expect(drive).toBe<DriveState>('MANUAL');
    expect(health).toBe<Health>('NOMINAL');
  });

  it('auto+failing mission — AUTO drive, FAILING health (distinguishable)', () => {
    const drive = deriveDriveState({ status: 'active', orchestrationMode: 'auto' });
    const health = deriveHealth(noDepMission, [makeTask('completed'), makeTask('failed')]);
    expect(drive).toBe<DriveState>('AUTO');
    expect(health).toBe<Health>('FAILING');
  });
});
