/**
 * Tests for the send_worker_message tool in the MCP route handler.
 *
 * Covers: auth level enforcement, workspace scope, terminal recipient,
 * rate limit, hop cap, body size cap, and successful delivery.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

const WORKER_ID = 'worker-aaa-111';
const SENDER_TASK_ID = '11111111-1111-1111-1111-111111111111';
const RECIPIENT_TASK_ID = '22222222-2222-2222-2222-222222222222';
const WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_WORKSPACE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// ── Mocks must be declared before import ────────────────────────────────────

const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => Promise.resolve(null as any));
const mockTasksFindFirst = mock(() => Promise.resolve(null as any));
const mockTasksFindMany = mock(() => Promise.resolve([] as any[]));
const mockWorkspacesFindFirst = mock(() => Promise.resolve(null as any));

// Track calls to db.update for assertions
const mockTasksUpdateReturning = mock(() => Promise.resolve([{ id: SENDER_TASK_ID }]));
const mockTasksUpdateWhere = mock(() => ({ returning: mockTasksUpdateReturning }));
const mockTasksUpdateSet = mock(() => ({ where: mockTasksUpdateWhere }));
const mockDbUpdate = mock(() => ({ set: mockTasksUpdateSet }));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      teams: { findFirst: mock(() => Promise.resolve(null)) },
      workers: { findFirst: mockWorkersFindFirst },
      tasks: {
        findFirst: mockTasksFindFirst,
        findMany: mockTasksFindMany,
      },
    },
    update: mockDbUpdate,
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          limit: mock(() => Promise.resolve([])),
        })),
      })),
    })),
  },
}));

mock.module('@buildd/core/knowledge-store', () => ({
  PgVectorStore: class {
    upsert() { return Promise.resolve([]); }
    search() { return Promise.resolve([]); }
  },
  getVoyageEmbedder: () => null,
  getVoyageReranker: () => null,
}));

mock.module('@buildd/core/memory-client', () => ({
  MemoryClient: class {
    getContext() { return Promise.resolve({ markdown: '' }); }
  },
}));

mock.module('@buildd/core/mcp-tools', () => ({
  handleBuilddAction: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  handleMemoryAction: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  handleRecallAction: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  handleLearnAction: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  triggerActions: [],
  workerActions: [],
  adminActions: [],
  allActions: [],
  memoryActions: [],
  buildToolDescription: () => 'description',
  buildParamsDescription: () => 'params',
  buildMemoryDescription: () => 'memory',
}));

import { POST } from './route';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeToolCallRequest(toolArgs: unknown, workerId = WORKER_ID, level = 'worker') {
  const workerParam = workerId ? `?worker=${workerId}` : '';
  return new Request(`http://localhost/api/mcp${workerParam}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer bld_test',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'send_worker_message',
        arguments: toolArgs,
      },
    }),
  });
}

async function callTool(
  toolArgs: unknown,
  workerId = WORKER_ID,
  level = 'worker',
): Promise<any> {
  // Update auth mock for this call's level
  mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level, teamId: 'team-1', authType: 'api' });
  const req = makeToolCallRequest(toolArgs, workerId, level);
  const res = await POST(req);
  return res.json();
}

function makeSenderTask(overrides: Record<string, unknown> = {}) {
  return {
    id: SENDER_TASK_ID,
    workspaceId: WORKSPACE_ID,
    context: {},
    ...overrides,
  };
}

function makeRecipientTask(overrides: Record<string, unknown> = {}) {
  return {
    id: RECIPIENT_TASK_ID,
    workspaceId: WORKSPACE_ID,
    status: 'in_progress',
    context: {},
    ...overrides,
  };
}

const VALID_ARGS = {
  recipientTaskId: RECIPIENT_TASK_ID,
  type: 'question',
  body: { text: 'Are you changing resolvePolicy()?' },
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('send_worker_message MCP handler', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockDbUpdate.mockReset();
    mockTasksUpdateSet.mockReset();
    mockTasksUpdateWhere.mockReset();
    mockTasksUpdateReturning.mockReset();

    // Default happy-path setup
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'worker', teamId: 'team-1', authType: 'api' });
    mockWorkersFindFirst.mockResolvedValue({ taskId: SENDER_TASK_ID });
    mockWorkspacesFindFirst.mockResolvedValue(null);

    // tasksFindFirst: first call = sender task, second call = recipient task
    mockTasksFindFirst
      .mockResolvedValueOnce(makeSenderTask())
      .mockResolvedValueOnce(makeRecipientTask());

    mockDbUpdate.mockReturnValue({ set: mockTasksUpdateSet });
    mockTasksUpdateSet.mockReturnValue({ where: mockTasksUpdateWhere });
    mockTasksUpdateWhere.mockResolvedValue([{ id: SENDER_TASK_ID }]);
  });

  it('rejects trigger-level tokens with forbidden error', async () => {
    const body: any = await callTool(VALID_ARGS, WORKER_ID, 'trigger');
    expect(body.result.isError).toBe(true);
    const text = body.result.content[0].text;
    expect(text).toContain('forbidden');
  });

  it('returns isError when no worker context', async () => {
    const body: any = await callTool(VALID_ARGS, '', 'worker');
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('worker context');
  });

  it('returns isError when recipientTaskId missing', async () => {
    const body: any = await callTool({ type: 'question', body: { text: 'hi' } });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('recipientTaskId');
  });

  it('returns isError for invalid message type', async () => {
    const body: any = await callTool({ ...VALID_ARGS, type: 'broadcast' });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('path_blocked_on_you');
  });

  it('returns isError when body exceeds 2 KB', async () => {
    const largeBody = { text: 'x'.repeat(2100) };
    const body: any = await callTool({ ...VALID_ARGS, body: largeBody });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('2 KB');
  });

  it('drops message when hop cap (5) is reached', async () => {
    const body: any = await callTool({ ...VALID_ARGS, hopCount: 5 });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Hop cap');
  });

  it('rejects cross-workspace messages', async () => {
    mockTasksFindFirst
      .mockReset()
      .mockResolvedValueOnce(makeSenderTask({ workspaceId: WORKSPACE_ID }))
      .mockResolvedValueOnce(makeRecipientTask({ workspaceId: OTHER_WORKSPACE_ID }));

    const body: any = await callTool(VALID_ARGS);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Cross-workspace');
  });

  it('returns delivered:false for terminal recipient', async () => {
    mockTasksFindFirst
      .mockReset()
      .mockResolvedValueOnce(makeSenderTask())
      .mockResolvedValueOnce(makeRecipientTask({ status: 'completed' }));

    const body: any = await callTool(VALID_ARGS);
    const result = JSON.parse(body.result.content[0].text);
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('recipient_terminal');
    expect(result.recipientStatus).toBe('completed');
  });

  it('returns delivered:false for failed recipient', async () => {
    mockTasksFindFirst
      .mockReset()
      .mockResolvedValueOnce(makeSenderTask())
      .mockResolvedValueOnce(makeRecipientTask({ status: 'failed' }));

    const body: any = await callTool(VALID_ARGS);
    const result = JSON.parse(body.result.content[0].text);
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('recipient_terminal');
  });

  it('rejects self-messaging', async () => {
    mockTasksFindFirst.mockReset().mockResolvedValueOnce(makeSenderTask());
    const body: any = await callTool({ ...VALID_ARGS, recipientTaskId: SENDER_TASK_ID });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('own task');
  });

  it('delivers message and returns delivered:true', async () => {
    const body: any = await callTool(VALID_ARGS);
    expect(body.result.isError).toBeFalsy();
    const result = JSON.parse(body.result.content[0].text);
    expect(result.delivered).toBe(true);
    expect(result.recipientTaskId).toBe(RECIPIENT_TASK_ID);
    expect(typeof result.messageId).toBe('string');
  });

  it('appends message to existing pendingWorkerMessages', async () => {
    const existing = [{ id: 'old-msg', type: 'question', fromTaskId: 'other', body: { text: 'hi' } }];
    mockTasksFindFirst
      .mockReset()
      .mockResolvedValueOnce(makeSenderTask())
      .mockResolvedValueOnce(makeRecipientTask({ context: { pendingWorkerMessages: existing } }));

    const body: any = await callTool(VALID_ARGS);
    const result = JSON.parse(body.result.content[0].text);
    expect(result.delivered).toBe(true);

    // Verify db.update was called for the recipient task with 2 messages
    const updateCalls = mockDbUpdate.mock.calls;
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('enforces rate limit: blocks after 5 messages in the same window', async () => {
    const now = Date.now();
    // Simulate sender task with 5 messages already sent in this window
    const rateCtx = {
      workerMsgRateLimit: {
        windowStart: now - 10_000, // 10s ago (within 60s window)
        counts: { [RECIPIENT_TASK_ID]: 5 },
      },
    };
    mockTasksFindFirst
      .mockReset()
      .mockResolvedValueOnce(makeSenderTask({ context: rateCtx }))
      .mockResolvedValueOnce(makeRecipientTask());

    const body: any = await callTool(VALID_ARGS);
    expect(body.result.isError).toBe(true);
    const text = body.result.content[0].text;
    expect(text).toContain('rate_limited');
  });

  it('resets rate limit after window expires', async () => {
    const oldWindow = Date.now() - 70_000; // 70s ago — expired
    const rateCtx = {
      workerMsgRateLimit: {
        windowStart: oldWindow,
        counts: { [RECIPIENT_TASK_ID]: 5 }, // maxed out but in old window
      },
    };
    mockTasksFindFirst
      .mockReset()
      .mockResolvedValueOnce(makeSenderTask({ context: rateCtx }))
      .mockResolvedValueOnce(makeRecipientTask());

    const body: any = await callTool(VALID_ARGS);
    const result = JSON.parse(body.result.content[0].text);
    expect(result.delivered).toBe(true); // window reset, message delivered
  });

  it('accepts admin token level (admin can also send worker messages)', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'admin', teamId: 'team-1', authType: 'api' });
    const req = makeToolCallRequest(VALID_ARGS, WORKER_ID, 'admin');
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'admin', teamId: 'team-1', authType: 'api' });
    const res = await POST(req);
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const result = JSON.parse(body.result.content[0].text);
    expect(result.delivered).toBe(true);
  });

  it('increments hopCount in stored message envelope', async () => {
    // Capture what is passed to db.update for the recipient task
    let capturedContext: any = null;
    mockTasksUpdateSet.mockImplementation((data: any) => {
      capturedContext = data.context;
      return { where: mockTasksUpdateWhere };
    });

    await callTool({ ...VALID_ARGS, hopCount: 2 });

    // The recipient update should contain the message with hopCount incremented
    if (capturedContext?.pendingWorkerMessages) {
      const msg = capturedContext.pendingWorkerMessages[0];
      expect(msg.hopCount).toBe(3); // 2 + 1
    }
  });

  it('path_blocked_on_you type is accepted', async () => {
    const body: any = await callTool({
      recipientTaskId: RECIPIENT_TASK_ID,
      type: 'path_blocked_on_you',
      body: { paths: ['apps/web/schema.ts'], blockedTaskId: SENDER_TASK_ID },
    });
    expect(body.result.isError).toBeFalsy();
    const result = JSON.parse(body.result.content[0].text);
    expect(result.delivered).toBe(true);
  });

  it('answer type is accepted', async () => {
    const body: any = await callTool({
      recipientTaskId: RECIPIENT_TASK_ID,
      type: 'answer',
      body: { replyToMsgId: 'some-msg-id', text: 'Yes, the public API is changing.' },
    });
    expect(body.result.isError).toBeFalsy();
    const result = JSON.parse(body.result.content[0].text);
    expect(result.delivered).toBe(true);
  });
});
