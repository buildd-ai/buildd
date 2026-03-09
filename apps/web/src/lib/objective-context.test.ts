import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { isWithinActiveHours } from './objective-context';

// ── isWithinActiveHours ──

describe('isWithinActiveHours', () => {
  it('returns true when hour is within normal range (9-17)', () => {
    expect(isWithinActiveHours(9, 9, 17)).toBe(true);
    expect(isWithinActiveHours(12, 9, 17)).toBe(true);
    expect(isWithinActiveHours(16, 9, 17)).toBe(true);
  });

  it('returns false when hour is outside normal range (9-17)', () => {
    expect(isWithinActiveHours(8, 9, 17)).toBe(false);
    expect(isWithinActiveHours(17, 9, 17)).toBe(false);
    expect(isWithinActiveHours(0, 9, 17)).toBe(false);
    expect(isWithinActiveHours(23, 9, 17)).toBe(false);
  });

  it('returns true when hour is within overnight range (22-6)', () => {
    expect(isWithinActiveHours(22, 22, 6)).toBe(true);
    expect(isWithinActiveHours(23, 22, 6)).toBe(true);
    expect(isWithinActiveHours(0, 22, 6)).toBe(true);
    expect(isWithinActiveHours(3, 22, 6)).toBe(true);
    expect(isWithinActiveHours(5, 22, 6)).toBe(true);
  });

  it('returns false when hour is outside overnight range (22-6)', () => {
    expect(isWithinActiveHours(6, 22, 6)).toBe(false);
    expect(isWithinActiveHours(12, 22, 6)).toBe(false);
    expect(isWithinActiveHours(21, 22, 6)).toBe(false);
  });

  it('returns true for all hours when start === end', () => {
    expect(isWithinActiveHours(0, 9, 9)).toBe(true);
    expect(isWithinActiveHours(9, 9, 9)).toBe(true);
    expect(isWithinActiveHours(23, 9, 9)).toBe(true);
  });

  it('handles boundary at hour 0', () => {
    expect(isWithinActiveHours(0, 0, 8)).toBe(true);
    expect(isWithinActiveHours(0, 1, 8)).toBe(false);
  });

  it('handles boundary at hour 23', () => {
    expect(isWithinActiveHours(23, 20, 0)).toBe(true);
    expect(isWithinActiveHours(23, 0, 23)).toBe(false);
  });

  it('handles full day range (0-24 treated as 0-0)', () => {
    // start === end => always active
    expect(isWithinActiveHours(12, 0, 0)).toBe(true);
  });
});

// ── buildObjectiveContext (mocked DB) ──

// Mock the DB module before importing the function under test
const mockFindFirst = mock(() => Promise.resolve(null));
const mockFindMany = mock(() => Promise.resolve([]));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      objectives: { findFirst: mockFindFirst },
      tasks: { findMany: mockFindMany },
      taskRecipes: { findFirst: mock(() => Promise.resolve(null)) },
    },
  },
}));

// Dynamic import so mocks are wired up
const { buildObjectiveContext } = await import('./objective-context');

describe('buildObjectiveContext', () => {
  beforeEach(() => {
    mockFindFirst.mockReset();
    mockFindMany.mockReset();
  });

  it('returns null when objective not found', async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    const result = await buildObjectiveContext('missing-id');
    expect(result).toBeNull();
  });

  it('returns standard context for non-heartbeat objective', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 'obj-1',
      title: 'Ship feature X',
      description: 'Build the new feature',
      status: 'active',
      priority: 1,
      isHeartbeat: false,
      heartbeatChecklist: null,
    });
    // completedTasks, activeTasks, failedTasks
    mockFindMany.mockResolvedValueOnce([]);
    mockFindMany.mockResolvedValueOnce([]);
    mockFindMany.mockResolvedValueOnce([]);

    const result = await buildObjectiveContext('obj-1');
    expect(result).not.toBeNull();
    expect(result!.description).toContain('## Objective: Ship feature X');
    expect(result!.description).toContain('Build the new feature');
    expect(result!.context.objectiveId).toBe('obj-1');
    // Should NOT have heartbeat fields
    expect(result!.context.heartbeat).toBeUndefined();
    expect(result!.context.outputSchema).toBeUndefined();
  });

  it('returns heartbeat context with checklist and protocol', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 'obj-hb',
      title: 'Daily health check',
      description: 'Check all services',
      status: 'active',
      priority: 0,
      isHeartbeat: true,
      heartbeatChecklist: '- [ ] Check API latency\n- [ ] Check error rate',
    });
    // priorHeartbeats query
    mockFindMany.mockResolvedValueOnce([]);

    const result = await buildObjectiveContext('obj-hb');
    expect(result).not.toBeNull();
    expect(result!.description).toContain('## Heartbeat: Daily health check');
    expect(result!.description).toContain('Check all services');
    expect(result!.description).toContain('## Checklist');
    expect(result!.description).toContain('Check API latency');
    expect(result!.description).toContain('## Protocol');
    expect(result!.description).toContain('periodic heartbeat check');
    expect(result!.description).toContain('report status "ok"');
  });

  it('includes outputSchema in heartbeat context', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 'obj-hb2',
      title: 'Heartbeat',
      description: null,
      status: 'active',
      priority: 0,
      isHeartbeat: true,
      heartbeatChecklist: '- check stuff',
    });
    mockFindMany.mockResolvedValueOnce([]);

    const result = await buildObjectiveContext('obj-hb2');
    expect(result).not.toBeNull();
    expect(result!.context.heartbeat).toBe(true);
    expect(result!.context.outputSchema).toBeDefined();
    const schema = result!.context.outputSchema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect((schema.properties as any).status.enum).toContain('ok');
    expect((schema.properties as any).status.enum).toContain('action_taken');
    expect((schema.properties as any).status.enum).toContain('error');
  });

  it('includes heartbeatChecklist in context data', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 'obj-hb3',
      title: 'Heartbeat',
      description: null,
      status: 'active',
      priority: 0,
      isHeartbeat: true,
      heartbeatChecklist: '- check A\n- check B',
    });
    mockFindMany.mockResolvedValueOnce([]);

    const result = await buildObjectiveContext('obj-hb3');
    expect(result!.context.heartbeatChecklist).toBe('- check A\n- check B');
  });

  it('shows compact prior heartbeat results', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 'obj-hb4',
      title: 'Heartbeat',
      description: null,
      status: 'active',
      priority: 0,
      isHeartbeat: true,
      heartbeatChecklist: '- check stuff',
    });
    mockFindMany.mockResolvedValueOnce([
      {
        result: {
          summary: 'All good',
          structuredOutput: { status: 'ok', summary: 'All systems nominal' },
        },
        createdAt: new Date(Date.now() - 3600000), // 1 hour ago
      },
      {
        result: {
          summary: 'Fixed cache',
          structuredOutput: { status: 'action_taken', summary: 'Cleared stale cache' },
        },
        createdAt: new Date(Date.now() - 7200000), // 2 hours ago
      },
    ]);

    const result = await buildObjectiveContext('obj-hb4');
    expect(result!.description).toContain('## Prior Heartbeats');
    expect(result!.description).toContain('[ok] All systems nominal');
    expect(result!.description).toContain('[action_taken] Cleared stale cache');
  });
});
