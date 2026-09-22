import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, buildParamsDescription, type ApiFn, type ActionContext } from '../mcp-tools';

const MOCK_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

function createMockContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: MOCK_WORKSPACE_ID,
    getWorkspaceId: async () => MOCK_WORKSPACE_ID,
    getLevel: async () => 'worker',
    ...overrides,
  };
}

describe('create_task — parentTaskId support', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
    mockApi.mockResolvedValue({ id: 'task-new', title: 'Test Task', priority: 5 });
  });

  it('passes parentTaskId to API when provided', async () => {
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: 'Retry: fix tests',
        description: 'Retry of previous attempt',
        parentTaskId: 'task-original-123',
      },
      createMockContext(),
    );

    expect(mockApi).toHaveBeenCalledTimes(1);
    const [endpoint, opts] = mockApi.mock.calls[0];
    expect(endpoint).toBe('/api/tasks');
    const body = JSON.parse(opts.body);
    expect(body.parentTaskId).toBe('task-original-123');
  });

  it('does not include parentTaskId when not provided', async () => {
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: 'Normal task',
        description: 'No parent',
      },
      createMockContext(),
    );

    const body = JSON.parse(mockApi.mock.calls[0][1].body);
    expect(body.parentTaskId).toBeUndefined();
  });

  it('passes baseBranch in context when provided', async () => {
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: 'Retry: fix tests',
        description: 'Continue from previous branch',
        parentTaskId: 'task-original-123',
        baseBranch: 'buildd/abc12345-fix-tests',
      },
      createMockContext(),
    );

    const body = JSON.parse(mockApi.mock.calls[0][1].body);
    expect(body.parentTaskId).toBe('task-original-123');
    expect(body.context.baseBranch).toBe('buildd/abc12345-fix-tests');
  });

  it('passes explicit and legacy subject identity through to task intake', async () => {
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: '[friction] sandbox failure',
        description: 'Observed the known sandbox failure.',
        subjectAnchor: {
          version: 1,
          kind: 'error',
          errorSignature: 'bwrap_namespace_denied',
          source: 'context',
          confidence: 'exact',
        },
        context: {
          frictionSignature: 'bwrap_namespace_denied',
          frictionExcerpt: 'bwrap: No permissions to create a new namespace',
        },
      },
      createMockContext(),
    );

    const body = JSON.parse(mockApi.mock.calls[0][1].body);
    expect(body.subjectAnchor.errorSignature).toBe('bwrap_namespace_denied');
    expect(body.context.frictionSignature).toBe('bwrap_namespace_denied');
  });

  it('passes verificationCommand in context when provided', async () => {
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: 'Task with verification',
        description: 'Will be verified',
        verificationCommand: 'bun test && bun run build',
      },
      createMockContext(),
    );

    const body = JSON.parse(mockApi.mock.calls[0][1].body);
    expect(body.context.verificationCommand).toBe('bun test && bun run build');
  });

  it('accepts and normalizes a strict loopConfig', async () => {
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: 'Loop until green',
        description: 'Keep fixing the suite',
        verificationCommand: 'bun test',
        loopConfig: {
          exitCondition: { type: 'command' },
          maxLoops: 4,
          backoffMinutes: 2,
        },
      },
      createMockContext(),
    );

    const body = JSON.parse(mockApi.mock.calls[0][1].body);
    expect(body.loopConfig).toEqual({
      exitCondition: { type: 'command', command: 'bun test' },
      maxLoops: 4,
      backoffMinutes: 2,
    });
  });

  it('expands loopUntilVerified shorthand into a command loop', async () => {
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: 'Authoritative verification',
        description: 'Do not stop until verified',
        verificationCommand: 'bun test',
        loopUntilVerified: true,
      },
      createMockContext(),
    );

    const body = JSON.parse(mockApi.mock.calls[0][1].body);
    expect(body.loopConfig).toEqual({
      exitCondition: { type: 'command', command: 'bun test' },
      maxLoops: 5,
      backoffMinutes: 0,
    });
  });

  it('rejects invalid loop shorthand and unknown nested loopConfig keys', async () => {
    await expect(handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: 'Missing command',
        description: 'Invalid shorthand',
        loopUntilVerified: true,
      },
      createMockContext(),
    )).rejects.toThrow('verificationCommand');

    await expect(handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: 'Unknown loop key',
        description: 'Invalid config',
        loopConfig: {
          exitCondition: { type: 'pr_checks_green' },
          forever: true,
        },
      },
      createMockContext(),
    )).rejects.toThrow('Unknown loopConfig key(s): forever');
  });

  it('passes iteration metadata in context when provided', async () => {
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: 'Retry attempt 3',
        description: 'Third attempt',
        parentTaskId: 'task-original',
        baseBranch: 'buildd/abc-fix',
        iteration: 3,
        maxIterations: 5,
        failureContext: 'Tests failed: 2 assertions in worker.test.ts',
      },
      createMockContext(),
    );

    const body = JSON.parse(mockApi.mock.calls[0][1].body);
    expect(body.parentTaskId).toBe('task-original');
    expect(body.context.baseBranch).toBe('buildd/abc-fix');
    expect(body.context.iteration).toBe(3);
    expect(body.context.maxIterations).toBe(5);
    expect(body.context.failureContext).toBe('Tests failed: 2 assertions in worker.test.ts');
  });

  it('mentions parentTaskId in response when set', async () => {
    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: 'Retry task',
        description: 'retry',
        parentTaskId: 'task-parent',
      },
      createMockContext(),
    );

    expect(result.content[0].text).toContain('Parent: task-parent');
  });

  it('includes taskUrl in response when appBaseUrl is set', async () => {
    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: 'New task',
        description: 'test',
      },
      createMockContext({ appBaseUrl: 'https://buildd.dev' }),
    );

    expect(result.content[0].text).toContain('https://buildd.dev/app/tasks/task-new');
  });

  it('includes taskUrl using default base URL when appBaseUrl not set', async () => {
    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: 'New task',
        description: 'test',
      },
      createMockContext(),
    );

    expect(result.content[0].text).toContain('https://buildd.dev/app/tasks/task-new');
  });

  it('response says queued with get_task hint instead of bare "pending"', async () => {
    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: 'New task',
        description: 'test',
      },
      createMockContext(),
    );

    expect(result.content[0].text).not.toContain('Status: pending');
    expect(result.content[0].text).toContain('Queued');
    expect(result.content[0].text).toContain('get_task');
    expect(result.content[0].text).toContain('task-new');
  });

  it('passes deferred start inputs through and echoes the resolved startAt', async () => {
    mockApi.mockResolvedValue({
      id: 'task-new',
      title: 'Later task',
      priority: 0,
      startAt: '2026-07-24T15:00:00.000Z',
      context: { startResolution: 'relative' },
    });
    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      { title: 'Later task', description: 'Wait', startIn: '3h' },
      createMockContext(),
    );

    expect(JSON.parse(mockApi.mock.calls[0][1].body).startIn).toBe('3h');
    expect(result.content[0].text).toContain('2026-07-24T15:00:00.000Z');
    expect(result.content[0].text).toContain('Resolution: relative');
  });

  it('rejects unknown parameters instead of silently dropping them', async () => {
    expect(handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      { title: 'Task', description: 'Test', startTomorrow: true },
      createMockContext(),
    )).rejects.toThrow('Unknown create_task parameter(s): startTomorrow');
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('rejects taskClass with a hint pointing to outputRequirement instead of a bare unknown-param error', async () => {
    expect(handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      { title: 'Task', description: 'Test', taskClass: 'bookkeeping' },
      createMockContext(),
    )).rejects.toThrow('taskClass is stamped server-side; use outputRequirement instead');
    expect(mockApi).not.toHaveBeenCalled();
  });
});

describe('create_task — similar open task detection', () => {
  const EXISTING_TASK_ID = 'b833be4b-0000-0000-0000-000000000001';
  const NEW_TASK_ID = 'e631d11c-0000-0000-0000-000000000001';

  function buildApi(activeTaskIds: string[] = [EXISTING_TASK_ID]) {
    return async (path: string, opts?: RequestInit) => {
      if (path.includes('status=active')) {
        return { tasks: activeTaskIds.map(id => ({ id, title: 'Open task', status: 'pending' })) };
      }
      // POST /api/tasks
      return { id: NEW_TASK_ID, title: 'Fix seat accounting', priority: 5, status: 'pending' };
    };
  }

  function buildStore(similarity: number) {
    return {
      nearDupeCheck: async (_ns: string, _text: string, _topK?: number) => [
        {
          id: `task:${EXISTING_TASK_ID}`,
          similarity,
          content: `# Task: Session-limited 'Waiting' workers squat concurrency seats`,
          sourceUrl: `/app/tasks/${EXISTING_TASK_ID}`,
        },
      ],
      upsert: async () => ({ superseded: 0 }),
    };
  }

  it('surfaces similar open task in response when similarity exceeds threshold', async () => {
    const result = await handleBuilddAction(
      buildApi() as unknown as ApiFn,
      'create_task',
      {
        title: 'Fix seat accounting: dead workers hold concurrency seats after session-limit and stale-reap',
        description: 'Workers in terminal state still hold seat count',
      },
      createMockContext({ knowledgeStore: buildStore(0.87) as any }),
    );

    expect(result.content[0].text).toContain('⚠');
    expect(result.content[0].text).toContain(EXISTING_TASK_ID);
    expect(result.content[0].text).toContain('0.87');
  });

  it('regression: two titles from the 2026-08-15 duplicate incident surface each other', async () => {
    const existingTitle = "Session-limited 'Waiting' workers squat concurrency seats and never auto-resume after reset";
    const newTitle = 'Fix seat accounting: dead workers hold concurrency seats after session-limit and stale-reap';

    const store = {
      nearDupeCheck: async (_ns: string, text: string) => {
        // Only respond when queried with the new task's text
        if (text.includes('seat accounting') || text.includes('stale-reap')) {
          return [{
            id: `task:${EXISTING_TASK_ID}`,
            similarity: 0.87,
            content: `# Task: ${existingTitle}`,
            sourceUrl: `/app/tasks/${EXISTING_TASK_ID}`,
          }];
        }
        return [];
      },
      upsert: async () => ({ superseded: 0 }),
    };

    const result = await handleBuilddAction(
      buildApi() as unknown as ApiFn,
      'create_task',
      { title: newTitle, description: 'dead workers hold seats' },
      createMockContext({ knowledgeStore: store as any }),
    );

    expect(result.content[0].text).toContain(EXISTING_TASK_ID);
  });

  it('does not warn when similarity is below threshold (0.82)', async () => {
    const result = await handleBuilddAction(
      buildApi() as unknown as ApiFn,
      'create_task',
      { title: 'Fix seat accounting', description: 'some description' },
      createMockContext({ knowledgeStore: buildStore(0.75) as any }),
    );

    expect(result.content[0].text).not.toContain('⚠');
  });

  it('does not warn when the candidate task is not in the active task list', async () => {
    const result = await handleBuilddAction(
      buildApi([]) as unknown as ApiFn, // no active tasks
      'create_task',
      { title: 'Fix seat accounting', description: 'some description' },
      createMockContext({ knowledgeStore: buildStore(0.87) as any }),
    );

    expect(result.content[0].text).not.toContain('⚠');
  });

  it('does not check when no knowledge store is in context', async () => {
    let nearDupeCheckCalled = false;
    const api = async (path: string) => {
      if (path.includes('status=active')) nearDupeCheckCalled = true;
      return { id: NEW_TASK_ID, title: 'Task', priority: 5, status: 'pending' };
    };
    const result = await handleBuilddAction(
      api as unknown as ApiFn,
      'create_task',
      { title: 'Fix seat accounting', description: 'some description' },
      createMockContext(), // no knowledgeStore
    );

    expect(nearDupeCheckCalled).toBe(false);
    expect(result.content[0].text).not.toContain('⚠');
  });

  it('does not check for child tasks (parentTaskId set)', async () => {
    let nearDupeCheckCalled = false;
    const store = {
      nearDupeCheck: async () => { nearDupeCheckCalled = true; return []; },
      upsert: async () => ({ superseded: 0 }),
    };
    await handleBuilddAction(
      buildApi() as unknown as ApiFn,
      'create_task',
      {
        title: 'Fix seat accounting: dead workers hold concurrency seats',
        description: 'retry of parent task',
        parentTaskId: 'parent-task-id',
      },
      createMockContext({ knowledgeStore: store as any }),
    );

    expect(nearDupeCheckCalled).toBe(false);
  });

  it('does not check for CI Retry tasks', async () => {
    let nearDupeCheckCalled = false;
    const store = {
      nearDupeCheck: async () => { nearDupeCheckCalled = true; return []; },
      upsert: async () => ({ superseded: 0 }),
    };
    await handleBuilddAction(
      buildApi() as unknown as ApiFn,
      'create_task',
      {
        title: '[CI Retry #2] Fix seat accounting: dead workers hold concurrency seats',
        description: 'retry after CI failure',
      },
      createMockContext({ knowledgeStore: store as any }),
    );

    expect(nearDupeCheckCalled).toBe(false);
  });

  it('does not check for reviewer tasks', async () => {
    let nearDupeCheckCalled = false;
    const store = {
      nearDupeCheck: async () => { nearDupeCheckCalled = true; return []; },
      upsert: async () => ({ superseded: 0 }),
    };
    await handleBuilddAction(
      buildApi() as unknown as ApiFn,
      'create_task',
      {
        title: '[reviewer] Fix seat accounting: dead workers hold concurrency seats',
        description: 'code review task',
      },
      createMockContext({ knowledgeStore: store as any }),
    );

    expect(nearDupeCheckCalled).toBe(false);
  });

  it('does not include the just-created task in the warning (no self-match)', async () => {
    const store = {
      nearDupeCheck: async () => [
        {
          id: `task:${NEW_TASK_ID}`, // same as new task
          similarity: 0.99,
          content: '# Task: Fix seat accounting',
          sourceUrl: `/app/tasks/${NEW_TASK_ID}`,
        },
      ],
      upsert: async () => ({ superseded: 0 }),
    };
    // active tasks includes new task but NOT an older existing task
    const api = async (path: string) => {
      if (path.includes('status=active')) return { tasks: [{ id: NEW_TASK_ID }] };
      return { id: NEW_TASK_ID, title: 'Fix seat accounting', priority: 5, status: 'pending' };
    };

    const result = await handleBuilddAction(
      api as unknown as ApiFn,
      'create_task',
      { title: 'Fix seat accounting', description: 'some description' },
      createMockContext({ knowledgeStore: store as any }),
    );

    expect(result.content[0].text).not.toContain('⚠');
  });

  it('indexes new task into knowledge store after creation (best-effort)', async () => {
    const upsertCalls: Array<{ ns: string; chunks: unknown[] }> = [];
    const store = {
      nearDupeCheck: async () => [],
      upsert: async (ns: string, chunks: unknown[]) => {
        upsertCalls.push({ ns, chunks });
        return { superseded: 0 };
      },
    };

    await handleBuilddAction(
      buildApi() as unknown as ApiFn,
      'create_task',
      { title: 'Fix seat accounting', description: 'some description' },
      createMockContext({ workspaceId: MOCK_WORKSPACE_ID, knowledgeStore: store as any }),
    );

    expect(upsertCalls.length).toBe(1);
    expect(upsertCalls[0].ns).toBe(`${MOCK_WORKSPACE_ID}:task`);
    const chunk = upsertCalls[0].chunks[0] as any;
    expect(chunk.id).toBe(`task:${NEW_TASK_ID}`);
    expect(chunk.content).toContain('Fix seat accounting');
  });
});

describe('create_task — prior work retrieval', () => {
  const NEW_TASK_ID = 'e631d11c-0000-0000-0000-000000000002';

  function buildApi() {
    return async (path: string) => {
      if (path.includes('status=active')) return { tasks: [] };
      return { id: NEW_TASK_ID, title: 'CTA still shows stale state', priority: 5, status: 'pending' };
    };
  }

  it('renders a "## Prior work" block with the stale-baseline flag for a task whose PR merged in the last 14 days', async () => {
    const store = {
      nearDupeCheck: async () => [],
      upsert: async () => ({ superseded: 0 }),
      query: async () => [{
        id: 'task:prior-cta-fix',
        namespace: `${MOCK_WORKSPACE_ID}:task`,
        corpus: 'task',
        sourceType: 'task',
        sourcePath: null,
        sourceUrl: '/app/tasks/prior-cta-fix',
        content: '# Task: CTA derives from server state, not cached UI',
        metadata: { success: true, prUrl: 'https://github.com/buildd-ai/buildd/pull/2361' },
        score: 0.81,
        createdAt: new Date(Date.now() - 5 * 86400000),
      }],
    };

    const result = await handleBuilddAction(
      buildApi() as unknown as ApiFn,
      'create_task',
      { title: 'CTA still shows stale state', description: 'The button shows the wrong action again' },
      createMockContext({ knowledgeStore: store as any }),
    );

    expect(result.content[0].text).toContain('## Prior work');
    expect(result.content[0].text).toContain('PR #2361');
    expect(result.content[0].text).toContain('MAY ALREADY BE SHIPPED');
  });

  it('places the prior-work block below the near-dupe warning', async () => {
    const store = {
      nearDupeCheck: async () => [{
        id: `task:existing`,
        similarity: 0.9,
        content: '# Task: CTA still shows stale state',
        sourceUrl: '/app/tasks/existing',
      }],
      upsert: async () => ({ superseded: 0 }),
      query: async () => [{
        id: 'task:prior-cta-fix',
        namespace: `${MOCK_WORKSPACE_ID}:task`,
        corpus: 'task',
        sourceType: 'task',
        sourcePath: null,
        sourceUrl: '/app/tasks/prior-cta-fix',
        content: '# Task: CTA derives from server state',
        metadata: {},
        score: 0.5,
        createdAt: new Date(),
      }],
    };
    const api = async (path: string) => {
      if (path.includes('status=active')) return { tasks: [{ id: 'existing', title: 'Open', status: 'pending' }] };
      return { id: 'existing2', title: 'CTA still shows stale state', priority: 5, status: 'pending' };
    };

    const result = await handleBuilddAction(
      api as unknown as ApiFn,
      'create_task',
      { title: 'CTA still shows stale state', description: 'desc' },
      createMockContext({ knowledgeStore: store as any }),
    );

    const text = result.content[0].text;
    const nearDupeIdx = text.indexOf('open task(s) with a similar subject');
    const priorWorkIdx = text.indexOf('## Prior work');
    expect(nearDupeIdx).toBeGreaterThan(-1);
    expect(priorWorkIdx).toBeGreaterThan(nearDupeIdx);
  });

  it('still returns the created task when the knowledge store query throws', async () => {
    const store = {
      nearDupeCheck: async () => [],
      upsert: async () => ({ superseded: 0 }),
      query: async () => { throw new Error('knowledge store unavailable'); },
    };

    const result = await handleBuilddAction(
      buildApi() as unknown as ApiFn,
      'create_task',
      { title: 'CTA still shows stale state', description: 'desc' },
      createMockContext({ knowledgeStore: store as any }),
    );

    expect(result.content[0].text).toContain(`Task created: "CTA still shows stale state" (ID: ${NEW_TASK_ID})`);
    expect(result.content[0].text).not.toContain('## Prior work');
  });

  it('renders nothing when there is no knowledge store in context', async () => {
    const result = await handleBuilddAction(
      buildApi() as unknown as ApiFn,
      'create_task',
      { title: 'CTA still shows stale state', description: 'desc' },
      createMockContext(),
    );

    expect(result.content[0].text).not.toContain('## Prior work');
  });
});

describe('create_task — fileAnywayReason support', () => {
  it('passes a trimmed explicit escape-hatch reason to task intake', async () => {
    let body: any;
    const api = async (_path: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return { id: 'task-new', title: 'Independent audit', priority: 0 };
    };
    await handleBuilddAction(
      api as ApiFn,
      'create_task',
      {
        title: 'Independent audit',
        description: 'Audit the same structured subject independently',
        workspaceId: MOCK_WORKSPACE_ID,
        fileAnywayReason: '  separate security review  ',
      },
      createMockContext(),
    );
    expect(body.fileAnywayReason).toBe('separate security review');
  });

  it('rejects a blank escape-hatch reason', async () => {
    await expect(handleBuilddAction(
      (async () => ({})) as ApiFn,
      'create_task',
      {
        title: 'Independent audit',
        description: 'Audit',
        workspaceId: MOCK_WORKSPACE_ID,
        fileAnywayReason: ' ',
      },
      createMockContext(),
    )).rejects.toThrow('fileAnywayReason must be a non-blank string');
  });
});

describe('create_task — kind/complexity routing inputs', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
    mockApi.mockResolvedValue({ id: 'task-new', title: 'Test Task', priority: 5, status: 'pending' });
  });

  it('forwards a valid kind/complexity pair to the task API', async () => {
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: 'Refactor claim route',
        description: 'Split the claim handler',
        kind: 'engineering',
        complexity: 'complex',
      },
      createMockContext(),
    );

    const body = JSON.parse(mockApi.mock.calls[0][1].body);
    expect(body.kind).toBe('engineering');
    expect(body.complexity).toBe('complex');
  });

  it('accepts every kind in the routing vocabulary', async () => {
    const kinds = ['coordination', 'engineering', 'research', 'writing', 'design', 'analysis', 'observation'];
    for (const kind of kinds) {
      mockApi.mockClear();
      await handleBuilddAction(
        mockApi as unknown as ApiFn,
        'create_task',
        { title: `Task ${kind}`, description: 'd', kind },
        createMockContext(),
      );
      const body = JSON.parse(mockApi.mock.calls[0][1].body);
      expect(body.kind).toBe(kind);
    }
  });

  it('rejects an invalid kind instead of silently dropping it', async () => {
    await expect(handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      { title: 'Task', description: 'd', kind: 'enginering' },
      createMockContext(),
    )).rejects.toThrow(/kind must be one of/);
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('rejects an invalid complexity instead of silently dropping it', async () => {
    await expect(handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      { title: 'Task', description: 'd', complexity: 'medium' },
      createMockContext(),
    )).rejects.toThrow(/complexity must be one of/);
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('omits kind/complexity when the caller does not set them', async () => {
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      { title: 'Task', description: 'd' },
      createMockContext(),
    );

    const body = JSON.parse(mockApi.mock.calls[0][1].body);
    expect(body.kind).toBeUndefined();
    expect(body.complexity).toBeUndefined();
  });

  it('surfaces the routing preview line when the API echoes one back', async () => {
    mockApi.mockResolvedValue({
      id: 'task-new',
      title: 'Test Task',
      priority: 5,
      status: 'pending',
      routing: { tier: 'standard', model: 'claude-sonnet-5', reason: 'no kind/complexity given — defaulted to engineering/normal → standard (Sonnet).' },
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      { title: 'Test Task', description: 'd' },
      createMockContext(),
    );

    expect(result.content[0].text).toContain('Model routing: no kind/complexity given');
  });

  it('omits the routing line when the API returns none', async () => {
    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      { title: 'Test Task', description: 'd' },
      createMockContext(),
    );

    expect(result.content[0].text).not.toContain('Model routing:');
  });

  it('documents kind and complexity in the create_task params description', () => {
    const description = buildParamsDescription(['create_task']);
    // `kind` deliberately carries NO `?` marker (mission-legibility Rule K2-12).
    // It stays optional in the schema — nothing 400s on its absence — but the
    // description stops presenting it as an afterthought, because it is the
    // only thing any surface draws a task's glyph from and nothing infers it
    // later from the title.
    expect(description).not.toContain('kind?');
    expect(description).toContain('kind (state it on every task');
    expect(description).toContain('the SHAPE of the work, not its subject');
    for (const k of ['coordination', 'engineering', 'research', 'writing', 'design', 'analysis', 'observation']) {
      expect(description).toContain(k);
    }
    expect(description).toContain('complexity?');
  });
});

describe('create_task — emitsPlan (spec-to-build)', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
    mockApi.mockResolvedValue({ id: 'task-new', title: 'Test Task', priority: 5, status: 'pending' });
  });

  it('forwards emitsPlan: true to the task API', async () => {
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: 'Spec: something',
        description: 'write a spec and propose a breakdown',
        emitsPlan: true,
        pathManifest: ['docs/design/something.md'],
      },
      createMockContext(),
    );

    const body = JSON.parse(mockApi.mock.calls[0][1].body);
    expect(body.emitsPlan).toBe(true);
  });

  it('omits emitsPlan when the caller does not set it', async () => {
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      { title: 'Task', description: 'd' },
      createMockContext(),
    );

    const body = JSON.parse(mockApi.mock.calls[0][1].body);
    expect(body.emitsPlan).toBeUndefined();
  });

  it('does not forward emitsPlan: false (default, byte-identical to omitting it)', async () => {
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      { title: 'Task', description: 'd', emitsPlan: false },
      createMockContext(),
    );

    const body = JSON.parse(mockApi.mock.calls[0][1].body);
    expect(body.emitsPlan).toBeUndefined();
  });

  it('documents emitsPlan in the create_task params description', () => {
    const description = buildParamsDescription(['create_task']);
    expect(description).toContain('emitsPlan?');
    expect(description).toContain('mode: "planning"');
    expect(description).toContain('requiresPlanApproval: true');
  });
});
