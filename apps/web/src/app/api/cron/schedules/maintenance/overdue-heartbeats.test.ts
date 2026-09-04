import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockTaskSchedulesFindMany = mock(() => [] as any[]);
const mockMissionsFindFirst = mock(() => null as any);
const mockNotify = mock(() => {});
const mockIsOverdue = mock(() => false);
const mockEstimateCronIntervalMs = mock(() => 30 * 60 * 1000);

let updateCalls: any[] = [];
// When set, the schedule lookup throws it — drives the swallow-everything path.
let findError: Error | null = null;

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      taskSchedules: {
        findMany: (...args: any[]) => {
          if (findError) throw findError;
          return mockTaskSchedulesFindMany(...(args as []));
        },
      },
      missions: { findFirst: mockMissionsFindFirst },
    },
    update: mock((table: any) => ({
      set: mock((vals: any) => {
        const entry: any = { table, set: vals };
        updateCalls.push(entry);
        return { where: mock((cond: any) => { entry.where = cond; return Promise.resolve(); }) };
      }),
    })),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => args,
  lt: (field: any, value: any) => ({ field, value, type: 'lt' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  taskSchedules: 'taskSchedules',
  missions: 'missions',
}));

mock.module('@/lib/heartbeat-helpers', () => ({
  isOverdue: mockIsOverdue,
  estimateCronIntervalMs: mockEstimateCronIntervalMs,
}));

mock.module('@/lib/pushover', () => ({ notify: mockNotify }));

import { runOverdueHeartbeatAlerts } from './overdue-heartbeats';

const NOW = new Date('2026-03-01T12:00:00Z');
const INTERVAL_MS = 30 * 60 * 1000;

function makeSchedule(overrides: Partial<any> = {}): any {
  return {
    id: 'sched-overdue',
    name: 'Fallback Schedule Name',
    cronExpression: '*/30 * * * *',
    enabled: true,
    // 90 min in the past → 3x the 30-min interval
    nextRunAt: new Date(NOW.getTime() - 90 * 60 * 1000),
    lastOverdueAlertAt: null,
    taskTemplate: { title: 'Heartbeat', context: { heartbeat: true } },
    ...overrides,
  };
}

/**
 * Behavioural contract (prose):
 *   - Only heartbeat schedules (taskTemplate.context.heartbeat === true) alert.
 *   - Only when isOverdue() says so, and only once per cron interval.
 *   - The alert names the linked mission, falling back to the schedule name.
 *   - Each alert stamps lastOverdueAlertAt so it self-rate-limits.
 *   - Any throw is swallowed: the cron tick must still return 200.
 */
describe('runOverdueHeartbeatAlerts', () => {
  beforeEach(() => {
    mockTaskSchedulesFindMany.mockReset();
    mockTaskSchedulesFindMany.mockResolvedValue([] as any);
    mockMissionsFindFirst.mockReset();
    mockMissionsFindFirst.mockResolvedValue(null as any);
    mockNotify.mockReset();
    mockIsOverdue.mockReset();
    mockIsOverdue.mockReturnValue(false);
    mockEstimateCronIntervalMs.mockReset();
    mockEstimateCronIntervalMs.mockReturnValue(INTERVAL_MS);
    updateCalls = [];
    findError = null;
  });

  it('alerts and stamps lastOverdueAlertAt for an overdue heartbeat schedule', async () => {
    mockTaskSchedulesFindMany.mockResolvedValue([makeSchedule()] as any);
    mockIsOverdue.mockReturnValue(true);
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', title: 'Example Mission' } as any);

    expect(await runOverdueHeartbeatAlerts(NOW)).toBe(1);

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const arg = (mockNotify.mock.calls[0] as any[])[0];
    expect(arg.app).toBe('alerts');
    expect(arg.title).toContain('Example Mission');
    expect(arg.message).toContain('90m overdue');

    // Without the stamp the alert would re-fire on every cron tick.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].set.lastOverdueAlertAt).toBe(NOW);
  });

  it('falls back to the schedule name when no mission is linked', async () => {
    mockTaskSchedulesFindMany.mockResolvedValue([makeSchedule()] as any);
    mockIsOverdue.mockReturnValue(true);
    mockMissionsFindFirst.mockResolvedValue(null as any);

    expect(await runOverdueHeartbeatAlerts(NOW)).toBe(1);
    expect((mockNotify.mock.calls[0] as any[])[0].title).toContain('Fallback Schedule Name');
  });

  it('ignores non-heartbeat schedules even when they are overdue', async () => {
    mockTaskSchedulesFindMany.mockResolvedValue([
      makeSchedule({ taskTemplate: { title: 'Plain', context: {} } }),
    ] as any);
    mockIsOverdue.mockReturnValue(true);

    expect(await runOverdueHeartbeatAlerts(NOW)).toBe(0);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('does not alert when isOverdue says the schedule is within tolerance', async () => {
    mockTaskSchedulesFindMany.mockResolvedValue([makeSchedule()] as any);
    mockIsOverdue.mockReturnValue(false);

    expect(await runOverdueHeartbeatAlerts(NOW)).toBe(0);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('rate-limits to one alert per cron interval', async () => {
    // Alerted 10 min ago, interval is 30 min → still inside the window.
    mockTaskSchedulesFindMany.mockResolvedValue([
      makeSchedule({ lastOverdueAlertAt: new Date(NOW.getTime() - 10 * 60 * 1000) }),
    ] as any);
    mockIsOverdue.mockReturnValue(true);

    expect(await runOverdueHeartbeatAlerts(NOW)).toBe(0);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
  });

  it('re-alerts once a full interval has elapsed since the last alert', async () => {
    mockTaskSchedulesFindMany.mockResolvedValue([
      makeSchedule({ lastOverdueAlertAt: new Date(NOW.getTime() - 35 * 60 * 1000) }),
    ] as any);
    mockIsOverdue.mockReturnValue(true);

    expect(await runOverdueHeartbeatAlerts(NOW)).toBe(1);
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('swallows a DB failure and reports 0 alerts so the cron tick still succeeds', async () => {
    findError = new Error('neon HTTP blip');
    expect(await runOverdueHeartbeatAlerts(NOW)).toBe(0);
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
