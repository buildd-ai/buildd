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
const mockSkillsFindMany = mock(() => Promise.resolve([]));
const mockSelectGroupBy = mock(() => Promise.resolve([]));
const mockSelectWhere = mock(() => ({ groupBy: mockSelectGroupBy }));
const mockSelectInnerJoin = mock(() => ({ where: mockSelectWhere }));
const mockSelectFrom = mock(() => ({ innerJoin: mockSelectInnerJoin }));
const mockSelect = mock(() => ({ from: mockSelectFrom }));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      objectives: { findFirst: mockFindFirst },
      tasks: { findMany: mockFindMany },
      taskRecipes: { findFirst: mock(() => Promise.resolve(null)) },
      workspaceSkills: { findMany: mockSkillsFindMany },
    },
    select: mockSelect,
  },
}));

// Dynamic import so mocks are wired up
const { buildObjectiveContext, getWorkspaceRoles } = await import('./objective-context');

describe('buildObjectiveContext', () => {
  beforeEach(() => {
    mockFindFirst.mockReset();
    mockFindMany.mockReset();
    mockSkillsFindMany.mockReset();
    mockSelectGroupBy.mockReset();
    mockSelectGroupBy.mockResolvedValue([]);
    mockSelectWhere.mockReset();
    mockSelectWhere.mockReturnValue({ groupBy: mockSelectGroupBy });
    mockSelectInnerJoin.mockReset();
    mockSelectInnerJoin.mockReturnValue({ where: mockSelectWhere });
    mockSelectFrom.mockReset();
    mockSelectFrom.mockReturnValue({ innerJoin: mockSelectInnerJoin });
    mockSelect.mockReset();
    mockSelect.mockReturnValue({ from: mockSelectFrom });
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
      workspaceId: 'ws-1',
    });
    // completedTasks, activeTasks, failedTasks
    mockFindMany.mockResolvedValueOnce([]);
    mockFindMany.mockResolvedValueOnce([]);
    mockFindMany.mockResolvedValueOnce([]);
    // roles query
    mockSkillsFindMany.mockResolvedValueOnce([]);

    const result = await buildObjectiveContext('obj-1');
    expect(result).not.toBeNull();
    expect(result!.description).toContain('## Objective: Ship feature X');
    expect(result!.description).toContain('Build the new feature');
    expect(result!.context.objectiveId).toBe('obj-1');
    expect(result!.context.orchestrator).toBe(true);
    // Should NOT have heartbeat fields
    expect(result!.context.heartbeat).toBeUndefined();
    expect(result!.context.outputSchema).toBeUndefined();
  });

  it('includes orchestrator instructions in standard context', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 'obj-2',
      title: 'Build auth',
      description: null,
      status: 'active',
      priority: 0,
      isHeartbeat: false,
      heartbeatChecklist: null,
      workspaceId: 'ws-1',
    });
    mockFindMany.mockResolvedValueOnce([]); // completed
    mockFindMany.mockResolvedValueOnce([]); // active
    mockFindMany.mockResolvedValueOnce([]); // failed
    mockSkillsFindMany.mockResolvedValueOnce([]);

    const result = await buildObjectiveContext('obj-2');
    expect(result!.description).toContain('## Orchestrator Instructions');
    expect(result!.description).toContain('You are the **orchestrator**');
    expect(result!.description).toContain('**Evaluate**');
    expect(result!.description).toContain('**Route**');
    expect(result!.description).toContain('**Create tasks**');
  });

  it('includes available roles in context', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 'obj-3',
      title: 'Ship it',
      description: null,
      status: 'active',
      priority: 0,
      isHeartbeat: false,
      heartbeatChecklist: null,
      workspaceId: 'ws-1',
    });
    mockFindMany.mockResolvedValueOnce([]); // completed
    mockFindMany.mockResolvedValueOnce([]); // active
    mockFindMany.mockResolvedValueOnce([]); // failed
    mockSkillsFindMany.mockResolvedValueOnce([
      { slug: 'builder', name: 'Builder', model: 'opus', color: '#3B82F6', description: 'Writes code' },
      { slug: 'researcher', name: 'Researcher', model: 'sonnet', color: '#D97706', description: 'Searches the web' },
    ]);

    const result = await buildObjectiveContext('obj-3');
    expect(result!.description).toContain('## Available Roles');
    expect(result!.description).toContain('**Builder** (`builder`)');
    expect(result!.description).toContain('**Researcher** (`researcher`)');
    expect(result!.description).toContain('Writes code');
    expect((result!.context.availableRoles as any[]).length).toBe(2);
    expect((result!.context.availableRoles as any[])[0].slug).toBe('builder');
  });

  it('detects recurring role pattern and enables efficiency mode', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 'obj-4',
      title: 'Monitor finances',
      description: null,
      status: 'active',
      priority: 0,
      isHeartbeat: false,
      heartbeatChecklist: null,
      workspaceId: 'ws-1',
    });
    // 4 completed tasks all with roleSlug 'accountant'
    mockFindMany.mockResolvedValueOnce([
      { id: 't1', title: 'Check Q1', mode: 'execution', result: { summary: 'Done' }, createdAt: new Date(), roleSlug: 'accountant' },
      { id: 't2', title: 'Check Q2', mode: 'execution', result: { summary: 'Done' }, createdAt: new Date(), roleSlug: 'accountant' },
      { id: 't3', title: 'Check Q3', mode: 'execution', result: { summary: 'Done' }, createdAt: new Date(), roleSlug: 'accountant' },
      { id: 't4', title: 'Check Q4', mode: 'execution', result: { summary: 'Done' }, createdAt: new Date(), roleSlug: 'accountant' },
    ]);
    mockFindMany.mockResolvedValueOnce([]); // active
    mockFindMany.mockResolvedValueOnce([]); // failed
    mockSkillsFindMany.mockResolvedValueOnce([
      { slug: 'accountant', name: 'Accountant', model: 'haiku', color: '#059669', description: null },
    ]);

    const result = await buildObjectiveContext('obj-4');
    expect(result!.description).toContain('**Pattern detected**');
    expect(result!.description).toContain('`accountant`');
    expect(result!.description).toContain('**Efficiency mode**');
    expect(result!.description).toContain('reuse');
  });

  it('surfaces nextSuggestion from completed tasks', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 'obj-5',
      title: 'Ship auth',
      description: null,
      status: 'active',
      priority: 0,
      isHeartbeat: false,
      heartbeatChecklist: null,
      workspaceId: 'ws-1',
    });
    mockFindMany.mockResolvedValueOnce([
      {
        id: 't1',
        title: 'Fix middleware',
        mode: 'execution',
        result: { summary: 'Fixed CORS', nextSuggestion: 'Tests pass, ready for review' },
        createdAt: new Date(),
        roleSlug: 'builder',
      },
    ]);
    mockFindMany.mockResolvedValueOnce([]); // active
    mockFindMany.mockResolvedValueOnce([]); // failed
    mockSkillsFindMany.mockResolvedValueOnce([]);

    const result = await buildObjectiveContext('obj-5');
    expect(result!.description).toContain('→ Next: "Tests pass, ready for review"');
    // Also in structured context
    const completions = result!.context.recentCompletions as any[];
    expect(completions[0].nextSuggestion).toBe('Tests pass, ready for review');
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

  it('does not enable efficiency mode with fewer than 3 same-role tasks', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 'obj-6',
      title: 'New mission',
      description: null,
      status: 'active',
      priority: 0,
      isHeartbeat: false,
      heartbeatChecklist: null,
      workspaceId: 'ws-1',
    });
    mockFindMany.mockResolvedValueOnce([
      { id: 't1', title: 'Task 1', mode: 'execution', result: { summary: 'Done' }, createdAt: new Date(), roleSlug: 'builder' },
      { id: 't2', title: 'Task 2', mode: 'execution', result: { summary: 'Done' }, createdAt: new Date(), roleSlug: 'researcher' },
    ]);
    mockFindMany.mockResolvedValueOnce([]); // active
    mockFindMany.mockResolvedValueOnce([]); // failed
    mockSkillsFindMany.mockResolvedValueOnce([]);

    const result = await buildObjectiveContext('obj-6');
    expect(result!.description).not.toContain('**Pattern detected**');
    expect(result!.description).not.toContain('**Efficiency mode**');
  });
});

// ── getWorkspaceRoles ──

describe('getWorkspaceRoles', () => {
  beforeEach(() => {
    mockSkillsFindMany.mockReset();
    mockSelectGroupBy.mockReset();
    mockSelectGroupBy.mockResolvedValue([]);
    mockSelectWhere.mockReset();
    mockSelectWhere.mockReturnValue({ groupBy: mockSelectGroupBy });
    mockSelectInnerJoin.mockReset();
    mockSelectInnerJoin.mockReturnValue({ where: mockSelectWhere });
    mockSelectFrom.mockReset();
    mockSelectFrom.mockReturnValue({ innerJoin: mockSelectInnerJoin });
    mockSelect.mockReset();
    mockSelect.mockReturnValue({ from: mockSelectFrom });
  });

  it('returns empty array when no roles exist', async () => {
    mockSkillsFindMany.mockResolvedValueOnce([]);
    const roles = await getWorkspaceRoles('ws-1');
    expect(roles).toEqual([]);
  });

  it('returns roles with currentLoad from active workers', async () => {
    mockSkillsFindMany.mockResolvedValueOnce([
      { slug: 'builder', name: 'Builder', model: 'opus', color: '#3B82F6', description: 'Writes code' },
    ]);
    mockSelectGroupBy.mockResolvedValueOnce([
      { roleSlug: 'builder', count: 2 },
    ]);

    const roles = await getWorkspaceRoles('ws-1');
    expect(roles.length).toBe(1);
    expect(roles[0].slug).toBe('builder');
    expect(roles[0].currentLoad).toBe(2);
  });

  it('deduplicates roles by slug', async () => {
    mockSkillsFindMany.mockResolvedValueOnce([
      { slug: 'builder', name: 'Builder', model: 'opus', color: '#3B82F6', description: 'V1' },
      { slug: 'builder', name: 'Builder', model: 'opus', color: '#3B82F6', description: 'V2' },
    ]);

    const roles = await getWorkspaceRoles('ws-1');
    expect(roles.length).toBe(1);
    expect(roles[0].description).toBe('V1'); // keeps first
  });
});
