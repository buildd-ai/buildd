import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Mock functions for db.query
const mockObjectivesFindFirst = mock(() => null as any);
const mockTasksFindMany = mock(() => [] as any[]);
const mockTaskRecipesFindFirst = mock(() => null as any);

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      objectives: { findFirst: mockObjectivesFindFirst },
      tasks: { findMany: mockTasksFindMany },
      taskRecipes: { findFirst: mockTaskRecipesFindFirst },
    },
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  desc: (field: any) => ({ field, type: 'desc' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  objectives: { id: 'id', status: 'status' },
  tasks: { id: 'id', objectiveId: 'objectiveId', status: 'status', createdAt: 'createdAt' },
  taskRecipes: { id: 'id' },
}));

// Import AFTER mocks
import { buildObjectiveContext } from './objective-context';

// Helper: tasks.findMany is called 3 times (completed, active, failed) in order.
// We use mockImplementation to return different results per call.
function setupTaskQueries(opts: {
  completed?: any[];
  active?: any[];
  failed?: any[];
}) {
  let callIndex = 0;
  const results = [
    opts.completed ?? [],
    opts.active ?? [],
    opts.failed ?? [],
  ];
  mockTasksFindMany.mockImplementation(() => {
    const result = results[callIndex] ?? [];
    callIndex++;
    return result;
  });
}

describe('buildObjectiveContext', () => {
  beforeEach(() => {
    mockObjectivesFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockTaskRecipesFindFirst.mockReset();
  });

  it('returns null when objective not found', async () => {
    mockObjectivesFindFirst.mockResolvedValue(null);

    const result = await buildObjectiveContext('nonexistent-id');
    expect(result).toBeNull();
  });

  it('builds context with objective metadata (title, description, priority)', async () => {
    mockObjectivesFindFirst.mockResolvedValue({
      id: 'obj-1',
      title: 'Ship v2.0',
      description: 'Release the next major version',
      status: 'active',
      priority: 8,
    });
    setupTaskQueries({});

    const result = await buildObjectiveContext('obj-1');
    expect(result).not.toBeNull();
    expect(result!.description).toContain('## Objective: Ship v2.0');
    expect(result!.description).toContain('Release the next major version');
    expect(result!.context.objectiveId).toBe('obj-1');
    expect(result!.context.objectiveTitle).toBe('Ship v2.0');
  });

  it('builds context with completed tasks history', async () => {
    mockObjectivesFindFirst.mockResolvedValue({
      id: 'obj-1',
      title: 'My Objective',
      description: null,
      status: 'active',
      priority: 5,
    });

    const completedTasks = [
      {
        id: 'task-1',
        title: 'Setup CI',
        mode: 'fire-and-forget',
        result: { summary: 'CI pipeline configured', structuredOutput: { pipeline: 'github-actions' } },
        createdAt: new Date(Date.now() - 3600000).toISOString(), // 1h ago
      },
      {
        id: 'task-2',
        title: 'Write tests',
        mode: 'planning',
        result: { summary: 'Tests added for auth module' },
        createdAt: new Date(Date.now() - 7200000).toISOString(), // 2h ago
      },
    ];

    setupTaskQueries({ completed: completedTasks });

    const result = await buildObjectiveContext('obj-1');
    expect(result).not.toBeNull();

    // Description should include prior results section
    expect(result!.description).toContain('## Prior Results');
    expect(result!.description).toContain('[Setup CI]');
    expect(result!.description).toContain('CI pipeline configured');
    expect(result!.description).toContain('[Write tests]');
    expect(result!.description).toContain('Tests added for auth module');
    // Structured output should be serialized
    expect(result!.description).toContain('"pipeline":"github-actions"');

    // Context data should include recentCompletions
    expect(result!.context.recentCompletions).toHaveLength(2);
    const first = (result!.context.recentCompletions as any[])[0];
    expect(first.taskId).toBe('task-1');
    expect(first.title).toBe('Setup CI');
    expect(first.mode).toBe('fire-and-forget');
    expect(first.summary).toBe('CI pipeline configured');
    expect(first.structuredOutput).toEqual({ pipeline: 'github-actions' });
  });

  it('builds context with active tasks', async () => {
    mockObjectivesFindFirst.mockResolvedValue({
      id: 'obj-1',
      title: 'My Objective',
      description: null,
      status: 'active',
      priority: 0,
    });

    const activeTasks = [
      { id: 'task-3', title: 'Deploy service', status: 'in_progress' },
      { id: 'task-4', title: 'Run migrations', status: 'pending' },
    ];

    setupTaskQueries({ active: activeTasks });

    const result = await buildObjectiveContext('obj-1');
    expect(result).not.toBeNull();

    expect(result!.description).toContain('## Active Tasks');
    expect(result!.description).toContain('[Deploy service] status: in_progress');
    expect(result!.description).toContain('[Run migrations] status: pending');

    expect(result!.context.activeTasks).toHaveLength(2);
    const first = (result!.context.activeTasks as any[])[0];
    expect(first.taskId).toBe('task-3');
    expect(first.title).toBe('Deploy service');
    expect(first.status).toBe('in_progress');
  });

  it('builds context with failed tasks', async () => {
    mockObjectivesFindFirst.mockResolvedValue({
      id: 'obj-1',
      title: 'My Objective',
      description: null,
      status: 'active',
      priority: 0,
    });

    const failedTasks = [
      { id: 'task-5', title: 'Deploy to prod', result: { summary: 'OOM killed' } },
      { id: 'task-6', title: 'Run e2e tests', result: null },
    ];

    setupTaskQueries({ failed: failedTasks });

    const result = await buildObjectiveContext('obj-1');
    expect(result).not.toBeNull();

    expect(result!.description).toContain('## Failed Tasks (recent)');
    expect(result!.description).toContain('[Deploy to prod] error: OOM killed');
    expect(result!.description).toContain('[Run e2e tests] error: unknown error');
  });

  it('handles empty task lists gracefully', async () => {
    mockObjectivesFindFirst.mockResolvedValue({
      id: 'obj-1',
      title: 'Empty Objective',
      description: 'Nothing done yet',
      status: 'active',
      priority: 0,
    });

    setupTaskQueries({});

    const result = await buildObjectiveContext('obj-1');
    expect(result).not.toBeNull();

    // Should have objective header, description, and instructions, but no task sections
    expect(result!.description).toContain('## Objective: Empty Objective');
    expect(result!.description).toContain('Nothing done yet');
    expect(result!.description).toContain('## Instructions');
    expect(result!.description).not.toContain('## Prior Results');
    expect(result!.description).not.toContain('## Active Tasks');
    expect(result!.description).not.toContain('## Failed Tasks');
    expect(result!.description).not.toContain('## Playbook');

    expect(result!.context.recentCompletions).toHaveLength(0);
    expect(result!.context.activeTasks).toHaveLength(0);
  });

  it('includes recipe playbook if configured via templateContext', async () => {
    mockObjectivesFindFirst.mockResolvedValue({
      id: 'obj-1',
      title: 'Recipe Objective',
      description: null,
      status: 'active',
      priority: 0,
    });

    setupTaskQueries({});

    mockTaskRecipesFindFirst.mockResolvedValue({
      name: 'Deploy Pipeline',
      steps: [
        { ref: 'step-1', title: 'Build image', description: 'Docker build' },
        { ref: 'step-2', title: 'Push to registry' },
        { title: 'Run smoke tests', description: 'Verify health endpoint' },
      ],
    });

    const result = await buildObjectiveContext('obj-1', { recipeId: 'recipe-123' });
    expect(result).not.toBeNull();

    expect(result!.description).toContain('## Playbook');
    expect(result!.description).toContain('- [ ] Build image: Docker build');
    expect(result!.description).toContain('- [ ] Push to registry');
    expect(result!.description).toContain('- [ ] Run smoke tests: Verify health endpoint');

    expect(result!.context.recipeSteps).toHaveLength(3);
  });

  it('does not include playbook when no recipeId in templateContext', async () => {
    mockObjectivesFindFirst.mockResolvedValue({
      id: 'obj-1',
      title: 'No Recipe',
      description: null,
      status: 'active',
      priority: 0,
    });

    setupTaskQueries({});

    const result = await buildObjectiveContext('obj-1');
    expect(result).not.toBeNull();

    expect(result!.description).not.toContain('## Playbook');
    expect(result!.context.recipeSteps).toBeUndefined();
    // Should not have queried recipes table
    expect(mockTaskRecipesFindFirst).not.toHaveBeenCalled();
  });

  it('does not include playbook when recipe not found', async () => {
    mockObjectivesFindFirst.mockResolvedValue({
      id: 'obj-1',
      title: 'Bad Recipe Ref',
      description: null,
      status: 'active',
      priority: 0,
    });

    setupTaskQueries({});
    mockTaskRecipesFindFirst.mockResolvedValue(null);

    const result = await buildObjectiveContext('obj-1', { recipeId: 'nonexistent' });
    expect(result).not.toBeNull();

    expect(result!.description).not.toContain('## Playbook');
    expect(result!.context.recipeSteps).toBeUndefined();
  });

  it('handles completed tasks with no result (null)', async () => {
    mockObjectivesFindFirst.mockResolvedValue({
      id: 'obj-1',
      title: 'Obj',
      description: null,
      status: 'active',
      priority: 0,
    });

    setupTaskQueries({
      completed: [
        { id: 'task-1', title: 'Silent task', mode: 'fire-and-forget', result: null, createdAt: new Date().toISOString() },
      ],
    });

    const result = await buildObjectiveContext('obj-1');
    expect(result).not.toBeNull();

    expect(result!.description).toContain('[Silent task]');
    expect(result!.description).toContain('no summary');

    const completions = result!.context.recentCompletions as any[];
    expect(completions[0].summary).toBeNull();
    expect(completions[0].structuredOutput).toBeNull();
  });

  it('combines all sections when tasks of every type exist', async () => {
    mockObjectivesFindFirst.mockResolvedValue({
      id: 'obj-1',
      title: 'Full Objective',
      description: 'A rich objective',
      status: 'active',
      priority: 10,
    });

    setupTaskQueries({
      completed: [
        { id: 't1', title: 'Done task', mode: 'planning', result: { summary: 'All good' }, createdAt: new Date().toISOString() },
      ],
      active: [
        { id: 't2', title: 'Running task', status: 'in_progress' },
      ],
      failed: [
        { id: 't3', title: 'Broken task', result: { summary: 'Timeout' } },
      ],
    });

    mockTaskRecipesFindFirst.mockResolvedValue({
      name: 'Steps',
      steps: [{ title: 'Step one' }],
    });

    const result = await buildObjectiveContext('obj-1', { recipeId: 'r-1' });
    expect(result).not.toBeNull();

    // All sections present
    expect(result!.description).toContain('## Objective: Full Objective');
    expect(result!.description).toContain('A rich objective');
    expect(result!.description).toContain('## Instructions');
    expect(result!.description).toContain('## Prior Results');
    expect(result!.description).toContain('## Active Tasks');
    expect(result!.description).toContain('## Failed Tasks (recent)');
    expect(result!.description).toContain('## Playbook');
  });

  it('detects repetitive results and adds warning + trims history', async () => {
    mockObjectivesFindFirst.mockResolvedValue({
      id: 'obj-1',
      title: 'Repetitive Obj',
      description: null,
      status: 'active',
      priority: 0,
    });

    // 5 tasks with same summary — triggers repetitive detection
    const sameSummary = 'All clear, nothing changed';
    const completedTasks = Array.from({ length: 5 }, (_, i) => ({
      id: `task-${i}`,
      title: 'Check-in',
      mode: 'planning',
      result: { summary: sameSummary },
      createdAt: new Date(Date.now() - i * 600000).toISOString(),
    }));

    setupTaskQueries({ completed: completedTasks });

    const result = await buildObjectiveContext('obj-1');
    expect(result).not.toBeNull();

    // Should have repetitive warning
    expect(result!.description).toContain('nearly identical results');
    // Should only show 2 results instead of all 5
    expect(result!.description).toContain('latest — earlier runs were similar');
    // Context flag should be set
    expect(result!.context.isRepetitive).toBe(true);
  });

  it('does not flag as repetitive when summaries are diverse', async () => {
    mockObjectivesFindFirst.mockResolvedValue({
      id: 'obj-1',
      title: 'Diverse Obj',
      description: null,
      status: 'active',
      priority: 0,
    });

    const completedTasks = [
      { id: 't1', title: 'A', mode: 'planning', result: { summary: 'Found 3 issues' }, createdAt: new Date().toISOString() },
      { id: 't2', title: 'B', mode: 'planning', result: { summary: 'Fixed auth bug' }, createdAt: new Date().toISOString() },
      { id: 't3', title: 'C', mode: 'planning', result: { summary: 'Deployed v2' }, createdAt: new Date().toISOString() },
    ];

    setupTaskQueries({ completed: completedTasks });

    const result = await buildObjectiveContext('obj-1');
    expect(result).not.toBeNull();
    expect(result!.description).not.toContain('nearly identical');
    expect(result!.context.isRepetitive).toBe(false);
  });

  it('omits description line when objective has no description', async () => {
    mockObjectivesFindFirst.mockResolvedValue({
      id: 'obj-1',
      title: 'No Desc',
      description: null,
      status: 'active',
      priority: 0,
    });

    setupTaskQueries({});

    const result = await buildObjectiveContext('obj-1');
    expect(result).not.toBeNull();

    // Description should have header + instructions, but no description line
    expect(result!.description).toContain('## Objective: No Desc');
    expect(result!.description).toContain('## Instructions');
    // Should NOT have a line between header and instructions (no description)
    const lines = result!.description.split('\n');
    expect(lines[0]).toBe('## Objective: No Desc');
    expect(lines[1]).toBe('');  // blank line before Instructions
    expect(lines[2]).toBe('## Instructions');
  });
});
