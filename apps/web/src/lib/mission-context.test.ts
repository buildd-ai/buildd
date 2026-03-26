import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { isWithinActiveHours } from './mission-context';

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

// ── buildMissionContext + getWorkspaceRoles (mocked DB) ──

const mockFindFirst = mock(() => Promise.resolve(null));
const mockFindMany = mock(() => Promise.resolve([]));
const mockScheduleFindFirst = mock(() => Promise.resolve(null));
const mockSkillsFindMany = mock(() => Promise.resolve([]));
const mockArtifactsFindMany = mock(() => Promise.resolve([]));

// Mock for db.select().from().innerJoin().where().groupBy() chain (workers query)
const mockSelectResult = mock(() => Promise.resolve([]));
const mockGroupBy = mock(() => mockSelectResult());
const mockWhere = mock(() => ({ groupBy: mockGroupBy }));
const mockInnerJoin = mock(() => ({ where: mockWhere }));
const mockFrom = mock(() => ({ innerJoin: mockInnerJoin }));
const mockSelect = mock(() => ({ from: mockFrom }));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockFindFirst },
      tasks: { findMany: mockFindMany },
      taskRecipes: { findFirst: mock(() => Promise.resolve(null)) },
      taskSchedules: { findFirst: mockScheduleFindFirst },
      workspaceSkills: { findMany: mockSkillsFindMany },
      artifacts: { findMany: mockArtifactsFindMany },
    },
    select: mockSelect,
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: unknown, b: unknown) => ({ field: a, value: b }),
  and: (...args: unknown[]) => args,
  inArray: (field: unknown, values: unknown[]) => ({ field, values }),
  desc: (field: unknown) => field,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => strings.join(''),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: { id: 'id', workspaceId: 'workspaceId', scheduleId: 'scheduleId' },
  tasks: { id: 'id', missionId: 'missionId', status: 'status', roleSlug: 'roleSlug' },
  taskRecipes: { id: 'id' },
  taskSchedules: { id: 'id' },
  workspaceSkills: { workspaceId: 'workspaceId', isRole: 'isRole', enabled: 'enabled' },
  workers: { id: 'id', taskId: 'taskId', workspaceId: 'workspaceId', status: 'status' },
  artifacts: { id: 'id', missionId: 'missionId', updatedAt: 'updatedAt' },
}));

// Dynamic import so mocks are wired up
const { buildMissionContext, getWorkspaceRoles } = await import('./mission-context');

describe('buildMissionContext', () => {
  beforeEach(() => {
    mockFindFirst.mockReset();
    mockFindMany.mockReset();
    mockScheduleFindFirst.mockReset();
    mockSkillsFindMany.mockReset();
    mockArtifactsFindMany.mockReset();
    mockArtifactsFindMany.mockResolvedValue([]);
    mockSelectResult.mockReset();
    mockSelectResult.mockResolvedValue([]);
    mockGroupBy.mockReset();
    mockGroupBy.mockImplementation(() => mockSelectResult());
    mockWhere.mockReset();
    mockWhere.mockReturnValue({ groupBy: mockGroupBy });
    mockInnerJoin.mockReset();
    mockInnerJoin.mockReturnValue({ where: mockWhere });
    mockFrom.mockReset();
    mockFrom.mockReturnValue({ innerJoin: mockInnerJoin });
    mockSelect.mockReset();
    mockSelect.mockReturnValue({ from: mockFrom });
  });

  it('returns null when mission not found', async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    const result = await buildMissionContext('missing-id');
    expect(result).toBeNull();
  });

  it('returns standard context for non-heartbeat mission', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 'obj-1',
      title: 'Ship feature X',
      description: 'Build the new feature',
      status: 'active',
      priority: 1,
      workspaceId: 'ws-1',
      scheduleId: null,
    });
    // completedTasks, activeTasks, failedTasks
    mockFindMany.mockResolvedValueOnce([]);
    mockFindMany.mockResolvedValueOnce([]);
    mockFindMany.mockResolvedValueOnce([]);
    mockSkillsFindMany.mockResolvedValueOnce([]);

    const result = await buildMissionContext('obj-1');
    expect(result).not.toBeNull();
    expect(result!.description).toContain('## Mission: Ship feature X');
    expect(result!.description).toContain('Build the new feature');
    expect(result!.context.missionId).toBe('obj-1');
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
      workspaceId: 'ws-1',
      scheduleId: null,
    });
    mockFindMany.mockResolvedValueOnce([]); // completed
    mockFindMany.mockResolvedValueOnce([]); // active
    mockFindMany.mockResolvedValueOnce([]); // failed
    mockSkillsFindMany.mockResolvedValueOnce([]);

    const result = await buildMissionContext('obj-2');
    expect(result!.description).toContain('## Situational Guidance');
    expect(result!.context.orchestrator).toBe(true);
  });

  it('includes available roles in context', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 'obj-3',
      title: 'Build auth',
      description: null,
      status: 'active',
      priority: 0,
      workspaceId: 'ws-1',
      scheduleId: null,
    });
    mockFindMany.mockResolvedValueOnce([]); // completed
    mockFindMany.mockResolvedValueOnce([]); // active
    mockFindMany.mockResolvedValueOnce([]); // failed
    mockSkillsFindMany.mockResolvedValueOnce([
      { slug: 'builder', name: 'Builder', model: 'opus', color: '#3B82F6', description: 'Writes code' },
      { slug: 'researcher', name: 'Researcher', model: 'sonnet', color: '#D97706', description: 'Finds info' },
    ]);
    mockSelectResult.mockResolvedValueOnce([]);

    const result = await buildMissionContext('obj-3');
    expect(result!.description).toContain('## Available Roles');
    expect(result!.description).toContain('Builder');
    expect(result!.description).toContain('Researcher');
    expect(result!.context.availableRoles).toBeDefined();
    const roles = result!.context.availableRoles as any[];
    expect(roles).toHaveLength(2);
    expect(roles[0].slug).toBe('builder');
  });

  it('detects recurring role pattern and enables efficiency mode', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 'obj-4',
      title: 'Daily scan',
      description: null,
      status: 'active',
      priority: 0,
      workspaceId: 'ws-1',
      scheduleId: null,
    });
    // 4 completed tasks all using same role
    mockFindMany.mockResolvedValueOnce([
      { id: 't1', title: 'Scan 1', mode: 'execution', result: { summary: 'OK' }, createdAt: new Date(), roleSlug: 'researcher' },
      { id: 't2', title: 'Scan 2', mode: 'execution', result: { summary: 'OK' }, createdAt: new Date(), roleSlug: 'researcher' },
      { id: 't3', title: 'Scan 3', mode: 'execution', result: { summary: 'OK' }, createdAt: new Date(), roleSlug: 'researcher' },
      { id: 't4', title: 'Scan 4', mode: 'execution', result: { summary: 'OK' }, createdAt: new Date(), roleSlug: 'researcher' },
    ]);
    mockFindMany.mockResolvedValueOnce([]); // active
    mockFindMany.mockResolvedValueOnce([]); // failed
    mockSkillsFindMany.mockResolvedValueOnce([
      { slug: 'researcher', name: 'Researcher', model: 'sonnet', color: '#D97706', description: null },
    ]);
    mockSelectResult.mockResolvedValueOnce([]);

    const result = await buildMissionContext('obj-4');
    expect(result!.description).toContain('Pattern detected');
    expect(result!.description).toContain('researcher');
    expect(result!.description).toContain('Efficiency mode');
    expect(result!.description).toContain('reuse');
  });

  it('does not enable efficiency mode with fewer than 3 same-role tasks', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 'obj-few',
      title: 'New mission',
      description: null,
      status: 'active',
      priority: 0,
      workspaceId: 'ws-1',
      scheduleId: null,
    });
    mockFindMany.mockResolvedValueOnce([
      { id: 't1', title: 'Task 1', mode: 'execution', result: { summary: 'Done' }, createdAt: new Date(), roleSlug: 'builder' },
      { id: 't2', title: 'Task 2', mode: 'execution', result: { summary: 'Done' }, createdAt: new Date(), roleSlug: 'researcher' },
    ]);
    mockFindMany.mockResolvedValueOnce([]); // tasksWithPRs (isBuild=true)
    mockFindMany.mockResolvedValueOnce([]); // active
    mockFindMany.mockResolvedValueOnce([]); // failed
    mockSkillsFindMany.mockResolvedValueOnce([]);

    const result = await buildMissionContext('obj-few');
    expect(result!.description).not.toContain('Pattern detected');
    expect(result!.description).not.toContain('Efficiency mode');
  });

  it('surfaces nextSuggestion from completed tasks', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 'obj-5',
      title: 'Ship auth',
      description: null,
      status: 'active',
      priority: 0,
      workspaceId: 'ws-1',
      scheduleId: null,
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
    mockFindMany.mockResolvedValueOnce([]); // tasksWithPRs (isBuild=true)
    mockFindMany.mockResolvedValueOnce([]); // active
    mockFindMany.mockResolvedValueOnce([]); // failed
    mockSkillsFindMany.mockResolvedValueOnce([]);

    const result = await buildMissionContext('obj-5');
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
      workspaceId: null,
      scheduleId: 'sched-1',
    });
    // Schedule lookup returns heartbeat config
    mockScheduleFindFirst.mockResolvedValueOnce({
      taskTemplate: { context: { heartbeat: true, heartbeatChecklist: '- [ ] Check API latency\n- [ ] Check error rate' } },
    });
    // priorHeartbeats query
    mockFindMany.mockResolvedValueOnce([]);

    const result = await buildMissionContext('obj-hb');
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
      workspaceId: null,
      scheduleId: 'sched-2',
    });
    mockScheduleFindFirst.mockResolvedValueOnce({
      taskTemplate: { context: { heartbeat: true, heartbeatChecklist: '- check stuff' } },
    });
    mockFindMany.mockResolvedValueOnce([]);

    const result = await buildMissionContext('obj-hb2');
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
      workspaceId: null,
      scheduleId: 'sched-3',
    });
    mockScheduleFindFirst.mockResolvedValueOnce({
      taskTemplate: { context: { heartbeat: true, heartbeatChecklist: '- check A\n- check B' } },
    });
    mockFindMany.mockResolvedValueOnce([]);

    const result = await buildMissionContext('obj-hb3');
    expect(result!.context.heartbeatChecklist).toBe('- check A\n- check B');
  });

  it('shows compact prior heartbeat results', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 'obj-hb4',
      title: 'Heartbeat',
      description: null,
      status: 'active',
      priority: 0,
      workspaceId: null,
      scheduleId: 'sched-4',
    });
    mockScheduleFindFirst.mockResolvedValueOnce({
      taskTemplate: { context: { heartbeat: true, heartbeatChecklist: '- check stuff' } },
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

    const result = await buildMissionContext('obj-hb4');
    expect(result!.description).toContain('## Prior Heartbeats');
    expect(result!.description).toContain('[ok] All systems nominal');
    expect(result!.description).toContain('[action_taken] Cleared stale cache');
  });

  it('includes prior artifacts in description when mission has linked artifacts', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 'obj-art',
      title: 'Research mission',
      description: null,
      status: 'active',
      priority: 0,
      workspaceId: 'ws-1',
      scheduleId: null,
    });
    mockFindMany.mockResolvedValueOnce([]); // completed
    mockFindMany.mockResolvedValueOnce([]); // active
    mockFindMany.mockResolvedValueOnce([]); // failed
    mockArtifactsFindMany.mockResolvedValueOnce([
      {
        id: 'art-1',
        key: 'mission-obj-art-research',
        type: 'document',
        title: 'Research Report',
        content: 'This is the research findings from the first run.',
        updatedAt: new Date(Date.now() - 3600000),
      },
    ]);
    mockSkillsFindMany.mockResolvedValueOnce([]);

    const result = await buildMissionContext('obj-art');
    expect(result).not.toBeNull();
    expect(result!.description).toContain('## Prior Artifacts');
    expect(result!.description).toContain('Research Report');
    expect(result!.description).toContain('document');
    expect(result!.description).toContain('mission-obj-art-research');
    expect(result!.description).toContain('This is the research findings');
    expect(result!.description).toContain('get_artifact');
  });

  it('includes artifact metadata in context data', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 'obj-art2',
      title: 'Analysis mission',
      description: null,
      status: 'active',
      priority: 0,
      workspaceId: 'ws-1',
      scheduleId: null,
    });
    mockFindMany.mockResolvedValueOnce([]); // completed
    mockFindMany.mockResolvedValueOnce([]); // active
    mockFindMany.mockResolvedValueOnce([]); // failed
    const updatedAt = new Date(Date.now() - 7200000);
    mockArtifactsFindMany.mockResolvedValueOnce([
      {
        id: 'art-2',
        key: 'mission-obj-art2-analysis',
        type: 'code',
        title: 'Analysis Output',
        content: 'Some analysis content here.',
        updatedAt,
      },
    ]);
    mockSkillsFindMany.mockResolvedValueOnce([]);

    const result = await buildMissionContext('obj-art2');
    expect(result).not.toBeNull();
    const artifacts = result!.context.priorArtifacts as any[];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifactId).toBe('art-2');
    expect(artifacts[0].key).toBe('mission-obj-art2-analysis');
    expect(artifacts[0].type).toBe('code');
    expect(artifacts[0].title).toBe('Analysis Output');
    expect(artifacts[0].updatedAt).toBe(updatedAt);
  });

  it('omits artifacts section when no linked artifacts exist', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 'obj-noart',
      title: 'New mission',
      description: null,
      status: 'active',
      priority: 0,
      workspaceId: 'ws-1',
      scheduleId: null,
    });
    mockFindMany.mockResolvedValueOnce([]); // completed
    mockFindMany.mockResolvedValueOnce([]); // active
    mockFindMany.mockResolvedValueOnce([]); // failed
    mockArtifactsFindMany.mockResolvedValueOnce([]); // no artifacts
    mockSkillsFindMany.mockResolvedValueOnce([]);

    const result = await buildMissionContext('obj-noart');
    expect(result).not.toBeNull();
    expect(result!.description).not.toContain('## Prior Artifacts');
    expect(result!.description).not.toContain('get_artifact');
    const artifacts = result!.context.priorArtifacts as any[];
    expect(artifacts).toHaveLength(0);
  });

  it('handles memory service unavailability gracefully', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 'obj-mem',
      title: 'Memory test mission',
      description: null,
      status: 'active',
      priority: 0,
      workspaceId: 'ws-1',
      scheduleId: null,
    });
    mockFindMany.mockResolvedValueOnce([]); // completed
    mockFindMany.mockResolvedValueOnce([]); // active
    mockFindMany.mockResolvedValueOnce([]); // failed
    mockArtifactsFindMany.mockResolvedValueOnce([]);
    mockSkillsFindMany.mockResolvedValueOnce([]);

    // Memory service is not available (no memory-client module) — should not throw
    const result = await buildMissionContext('obj-mem');
    expect(result).not.toBeNull();
    expect(result!.context.missionId).toBe('obj-mem');
  });

  it('detects heartbeat from templateContext argument', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 'obj-tc',
      title: 'TC Heartbeat',
      description: null,
      status: 'active',
      priority: 0,
      workspaceId: null,
      scheduleId: null,
    });
    mockFindMany.mockResolvedValueOnce([]);

    const result = await buildMissionContext('obj-tc', {
      heartbeat: true,
      heartbeatChecklist: '- check via template',
    });
    expect(result).not.toBeNull();
    expect(result!.description).toContain('## Heartbeat: TC Heartbeat');
    expect(result!.context.heartbeat).toBe(true);
  });
});

// ── getWorkspaceRoles ──

describe('getWorkspaceRoles', () => {
  beforeEach(() => {
    mockSkillsFindMany.mockReset();
    mockSelectResult.mockReset();
    mockSelectResult.mockResolvedValue([]);
    mockGroupBy.mockReset();
    mockGroupBy.mockImplementation(() => mockSelectResult());
    mockWhere.mockReset();
    mockWhere.mockReturnValue({ groupBy: mockGroupBy });
    mockInnerJoin.mockReset();
    mockInnerJoin.mockReturnValue({ where: mockWhere });
    mockFrom.mockReset();
    mockFrom.mockReturnValue({ innerJoin: mockInnerJoin });
    mockSelect.mockReset();
    mockSelect.mockReturnValue({ from: mockFrom });
  });

  it('returns empty array when no roles exist', async () => {
    mockSkillsFindMany.mockResolvedValueOnce([]);
    const roles = await getWorkspaceRoles('ws-empty');
    expect(roles).toHaveLength(0);
  });

  it('returns roles with current load', async () => {
    mockSkillsFindMany.mockResolvedValueOnce([
      { slug: 'builder', name: 'Builder', model: 'opus', color: '#3B82F6', description: 'Writes code' },
    ]);
    mockSelectResult.mockResolvedValueOnce([
      { roleSlug: 'builder', count: 2 },
    ]);

    const roles = await getWorkspaceRoles('ws-1');
    expect(roles).toHaveLength(1);
    expect(roles[0].slug).toBe('builder');
    expect(roles[0].currentLoad).toBe(2);
  });

  it('deduplicates roles by slug', async () => {
    mockSkillsFindMany.mockResolvedValueOnce([
      { slug: 'builder', name: 'Builder', model: 'opus', color: '#3B82F6', description: null },
      { slug: 'builder', name: 'Builder v2', model: 'opus', color: '#3B82F6', description: null },
      { slug: 'researcher', name: 'Researcher', model: 'sonnet', color: '#D97706', description: null },
    ]);
    mockSelectResult.mockResolvedValueOnce([]);

    const roles = await getWorkspaceRoles('ws-dup');
    expect(roles).toHaveLength(2);
    expect(roles[0].slug).toBe('builder');
    expect(roles[1].slug).toBe('researcher');
  });
});
