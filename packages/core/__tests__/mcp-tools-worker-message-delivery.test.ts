/**
 * update_progress must DELIVER worker→worker messages, not just carry them.
 *
 * PATCH /api/workers/[id] returns `pendingMessages[]` (written by
 * send_worker_message and by the passive path-overlap notifier). Before this
 * change nothing read that field: the route drained the queue and the messages
 * were destroyed unread. Delivery mirrors the instruction protocol — surface
 * the text in the tool result, then ACK by id so the queue is cleared only
 * once the agent has actually seen it.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const WS_ID = '00000000-0000-0000-0000-000000000001';
const WORKER_ID = '22222222-2222-2222-2222-222222222222';
const SENDER_TASK = '33333333-3333-3333-3333-333333333333';

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: WS_ID,
    workerId: WORKER_ID,
    getWorkspaceId: async () => WS_ID,
    getLevel: async () => 'worker',
    ...overrides,
  } as ActionContext;
}

const question = {
  id: 'msg-1',
  type: 'question',
  fromTaskId: SENDER_TASK,
  fromWorkerId: 'worker-sender',
  sentAt: '2026-09-04T10:00:00.000Z',
  hopCount: 1,
  body: { text: 'Are you regenerating the drizzle journal? I need to add a column.' },
};

const released = {
  id: 'msg-2',
  type: 'path_released',
  fromTaskId: SENDER_TASK,
  sentAt: '2026-09-04T10:05:00.000Z',
  hopCount: 0,
  body: { paths: ['packages/core/db/schema.ts'], releasedAt: '2026-09-04T10:05:00.000Z' },
};

describe('update_progress — worker message delivery', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('surfaces pending worker messages in the tool result', async () => {
    mockApi.mockResolvedValue({ ok: true, pendingMessages: [question] });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_progress',
      { progress: 50, message: 'halfway' },
      ctx(),
    );

    const out = result.content[0].text;
    expect(out).toContain('AGENT MESSAGE');
    expect(out).toContain('drizzle journal');
    expect(out).toContain(SENDER_TASK);
    expect(out).toContain('question');
  });

  it('acks delivered message ids so the queue is cleared exactly once', async () => {
    mockApi.mockResolvedValue({ ok: true, pendingMessages: [question, released] });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_progress',
      { progress: 50 },
      ctx(),
    );

    const ackCall = mockApi.mock.calls.find(([, opts]: any[]) =>
      typeof opts?.body === 'string' && opts.body.includes('workerMessagesDelivered'));
    expect(ackCall).toBeDefined();
    expect(ackCall![0]).toBe(`/api/workers/${WORKER_ID}`);
    expect(JSON.parse(ackCall![1].body).workerMessagesDelivered).toEqual(['msg-1', 'msg-2']);
  });

  it('renders a path_released body as a rebase instruction', async () => {
    mockApi.mockResolvedValue({ ok: true, pendingMessages: [released] });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_progress',
      { progress: 10 },
      ctx(),
    );

    const out = result.content[0].text;
    expect(out).toContain('packages/core/db/schema.ts');
    expect(out).toMatch(/rebase|base moved|merged/i);
  });

  it('sends no ack and adds no message block when there are no messages', async () => {
    mockApi.mockResolvedValue({ ok: true });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_progress',
      { progress: 25 },
      ctx(),
    );

    expect(result.content[0].text).not.toContain('AGENT MESSAGE');
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  it('still returns the messages to the agent when the ack call fails', async () => {
    mockApi.mockImplementation(async (_path: string, opts?: any) => {
      if (typeof opts?.body === 'string' && opts.body.includes('workerMessagesDelivered')) {
        throw new Error('500 ack failed');
      }
      return { ok: true, pendingMessages: [question] };
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_progress',
      { progress: 75 },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('AGENT MESSAGE');
  });

  it('delivers messages alongside an admin instruction without dropping either', async () => {
    mockApi.mockResolvedValue({
      ok: true,
      instructions: 'switch to the other repo',
      instructionsAck: 'switch to the other repo',
      pendingMessages: [question],
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_progress',
      { progress: 60 },
      ctx(),
    );

    const out = result.content[0].text;
    expect(out).toContain('ADMIN INSTRUCTION');
    expect(out).toContain('AGENT MESSAGE');
    const bodies = mockApi.mock.calls
      .map(([, o]: any[]) => (typeof o?.body === 'string' ? o.body : ''))
      .join('|');
    expect(bodies).toContain('instructionsDelivered');
    expect(bodies).toContain('workerMessagesDelivered');
  });
});
