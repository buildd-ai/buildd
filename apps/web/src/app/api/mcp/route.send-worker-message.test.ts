/**
 * Tests for the send_worker_message tool in the MCP route handler.
 *
 * Covers: auth level enforcement, workspace scope, terminal recipient,
 * rate limit, hop cap, body size cap, and successful delivery.
 *
 * Both writes are asserted as rendered SQL (PgDialect): with a mocked db the
 * resulting context is unobservable, and a whole-object `context: {...}` write
 * is exactly the lost-update bug this handler used to have.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

const WORKER_ID = 'a1a1a1a1-0000-4000-8000-000000000111';
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

mock.module('@buildd/core/memory-store', () => ({
  MemoryStore: class {
    search() { return Promise.resolve({ results: [], total: 0 }); }
    batch() { return Promise.resolve({ memories: [] }); }
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

import { PgDialect } from 'drizzle-orm/pg-core';
import { SQL } from 'drizzle-orm';
import { POST } from './route';

const dialect = new PgDialect();
const rendered = (v: unknown) => dialect.sqlToQuery(v as any);

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
    mockWorkersFindFirst.mockResolvedValue({ taskId: SENDER_TASK_ID, accountId: 'acc-1', workspace: { teamId: 'team-1' } });
    mockWorkspacesFindFirst.mockResolvedValue(null);

    // tasksFindFirst: first call = sender task, second call = recipient task
    mockTasksFindFirst
      .mockResolvedValueOnce(makeSenderTask())
      .mockResolvedValueOnce(makeRecipientTask());

    mockDbUpdate.mockReturnValue({ set: mockTasksUpdateSet });
    mockTasksUpdateSet.mockReturnValue({ where: mockTasksUpdateWhere });
    mockTasksUpdateWhere.mockReturnValue({ returning: mockTasksUpdateReturning });
    mockTasksUpdateReturning.mockResolvedValue([{ id: SENDER_TASK_ID }]);
  });

  it('refuses a ?worker= id that belongs to another account and team', async () => {
    mockWorkersFindFirst.mockResolvedValue({ taskId: SENDER_TASK_ID, accountId: 'acc-other', workspace: { teamId: 'team-other' } });
    const res = await POST(makeToolCallRequest(VALID_ARGS, WORKER_ID, 'worker'));
    expect(res.status).toBe(403);
    expect(mockDbUpdate).not.toHaveBeenCalled();
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

  // Regression: the handler read tasks.context and wrote the whole object back
  // for BOTH the sender's rate-limit counter and the recipient's queue. Two
  // concurrent sends (or a send racing the recipient's own check-in) lost
  // messages and clobbered unrelated context keys.
  it('never writes a whole context object — both writes are jsonb expressions', async () => {
    const sets: any[] = [];
    mockTasksUpdateSet.mockImplementation((data: any) => {
      sets.push(data);
      return { where: mockTasksUpdateWhere };
    });

    const body: any = await callTool(VALID_ARGS);
    expect(JSON.parse(body.result.content[0].text).delivered).toBe(true);

    expect(sets).toHaveLength(2);
    for (const s of sets) {
      expect(s.context).toBeInstanceOf(SQL);
      expect(rendered(s.context).sql).toContain('jsonb_set(');
    }
    const [rateWrite, queueWrite] = sets.map(s => rendered(s.context));
    expect(rateWrite.sql).toContain("'{workerMsgRateLimit}'");
    expect(rateWrite.sql).not.toContain('pendingWorkerMessages');
    expect(queueWrite.sql).toContain("'{pendingWorkerMessages}'");
    expect(queueWrite.sql).not.toContain('workerMsgRateLimit');
  });

  it('enqueues the message atomically with an incremented hopCount, capped', async () => {
    let queueSet: any = null;
    mockTasksUpdateSet.mockImplementation((data: any) => {
      if (rendered(data.context).sql.includes('pendingWorkerMessages')) queueSet = data;
      return { where: mockTasksUpdateWhere };
    });

    await callTool({ ...VALID_ARGS, hopCount: 2 });

    expect(queueSet).not.toBeNull();
    const q = rendered(queueSet.context);
    // appended from the column itself, not from a copy read earlier
    expect(q.sql).toContain(`COALESCE("tasks"."context" -> 'pendingWorkerMessages', '[]'::jsonb) ||`);
    const payload = q.params.find((p: unknown) => typeof p === 'string' && p.includes('"hopCount"')) as string;
    const [msg] = JSON.parse(payload);
    expect(msg.hopCount).toBe(3);
    expect(msg.fromTaskId).toBe(SENDER_TASK_ID);
    expect(msg.type).toBe('question');
    expect(q.params).toContain(3); // WORKER_MESSAGE_CAP
  });

  it('rate limit is enforced in the UPDATE itself (check + increment in one statement)', async () => {
    const wheres: any[] = [];
    const sets: any[] = [];
    mockTasksUpdateSet.mockImplementation((data: any) => {
      sets.push(data);
      return { where: mockTasksUpdateWhere };
    });
    mockTasksUpdateWhere.mockImplementation((w: any) => {
      wheres.push(w);
      return { returning: mockTasksUpdateReturning };
    });

    await callTool(VALID_ARGS);

    const set = rendered(sets[0].context);
    expect(set.sql).toContain(`COALESCE("tasks"."context" -> 'workerMsgRateLimit', '{}'::jsonb)`);
    expect(set.params).toContain(RECIPIENT_TASK_ID);
    const where = rendered(wheres[0]);
    expect(where.sql).toContain('"tasks"."id" =');
    expect(where.sql).toMatch(/< \$\d+/);
    expect(where.params).toContain(5);
    expect(where.params).toContain(SENDER_TASK_ID);
  });

  it('returns rate_limited and does not enqueue when the guarded UPDATE matches no row', async () => {
    const now = Date.now();
    mockTasksFindFirst
      .mockReset()
      .mockResolvedValueOnce(makeSenderTask({
        context: { workerMsgRateLimit: { windowStart: now - 10_000, counts: { [RECIPIENT_TASK_ID]: 5 } } },
      }))
      .mockResolvedValueOnce(makeRecipientTask());
    mockTasksUpdateReturning.mockReset().mockResolvedValueOnce([]);

    const body: any = await callTool(VALID_ARGS);
    expect(body.result.isError).toBe(true);
    const result = JSON.parse(body.result.content[0].text);
    expect(result.error).toBe('rate_limited');
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(result.retryAfter).toBeLessThanOrEqual(60);
    expect(mockDbUpdate).toHaveBeenCalledTimes(1);
  });

  it('reports not found when the recipient row vanishes before the enqueue', async () => {
    mockTasksUpdateReturning
      .mockReset()
      .mockResolvedValueOnce([{ id: SENDER_TASK_ID }])
      .mockResolvedValueOnce([]);

    const body: any = await callTool(VALID_ARGS);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('not found');
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
