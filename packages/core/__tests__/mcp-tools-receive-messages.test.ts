import { describe, expect, it, mock } from 'bun:test';
import {
  handleBuilddAction,
  workerActions,
  type ActionContext,
  type ApiFn,
} from '../mcp-tools';

const WORKER_ID = 'worker-recv-1';

const context: ActionContext = {
  workerId: WORKER_ID,
  workspaceId: 'workspace-1',
  getWorkspaceId: async () => 'workspace-1',
  getLevel: async () => 'worker',
  authType: 'api',
};

/**
 * A minimal server: one queue, served to a consumer, cleared by the echo.
 * Mirrors PATCH /api/workers/[id]'s contract closely enough to show B-10's
 * "returns the text once, then nothing".
 */
function fakeServer() {
  let queue: string | null = 'Stop and switch to the device flow';
  const ids = ['i-1'];
  let workerMessages = [{ id: 'm-1', type: 'question', fromTaskId: 't-2', fromWorkerId: 'w-2', sentAt: '2026-01-01T00:00:00Z', hopCount: 0, body: { text: 'Are you touching auth.ts?' } }];
  const bodies: any[] = [];
  const api = mock(async (_path: string, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    bodies.push(body);
    if (typeof body.instructionsDelivered === 'string' && queue && body.instructionsDelivered.includes(queue)) queue = null;
    if (Array.isArray(body.workerMessagesDelivered)) {
      workerMessages = workerMessages.filter(m => !body.workerMessagesDelivered.includes(m.id));
    }
    if (body.consumer !== 'agent') return {};
    return {
      ...(queue ? { instructions: queue, instructionsAck: queue, instructionIds: ids } : {}),
      ...(workerMessages.length > 0 ? { pendingMessages: workerMessages } : {}),
    };
  });
  return { api, bodies };
}

describe('MCP receive_messages (B-10)', () => {
  it('is a worker-level action', () => {
    expect(workerActions).toContain('receive_messages');
  });

  it('returns queued text once, acks it delivered + read by id, and a second call returns nothing', async () => {
    const { api, bodies } = fakeServer();

    const first = await handleBuilddAction(api as unknown as ApiFn, 'receive_messages', {}, context);
    const text1 = first.content[0]?.text ?? '';
    expect(text1).toContain('Stop and switch to the device flow');
    expect(text1).toContain('Are you touching auth.ts?');

    // Serve PATCH declares the agent consumer and carries nothing that counts
    // as progress (no status, no milestones).
    expect(bodies[0]).toEqual({ consumer: 'agent' });
    const ack = bodies.find(b => typeof b.instructionsDelivered === 'string');
    expect(ack.instructionIdsDelivered).toEqual(['i-1']);
    expect(ack.instructionsAcknowledged).toEqual(['i-1']);
    expect(bodies.some(b => Array.isArray(b.workerMessagesDelivered) && b.workerMessagesDelivered.includes('m-1'))).toBe(true);

    const second = await handleBuilddAction(api as unknown as ApiFn, 'receive_messages', {}, context);
    expect(second.content[0]?.text).toMatch(/No messages/);
    expect(second.content[0]?.text).not.toContain('device flow');
  });

  it('on a runner-managed worker (server serves nothing) says so plainly', async () => {
    const api = mock(async () => ({}));
    const result = await handleBuilddAction(api as unknown as ApiFn, 'receive_messages', {}, context);
    expect(result.content[0]?.text).toMatch(/No messages/);
    expect(api).toHaveBeenCalledTimes(1);
  });
});

describe('MCP get_task_messages (B-11)', () => {
  const TASK_ID = '22222222-2222-4222-8222-222222222222';

  it('prints one of QUEUED / DELIVERED / ACKNOWLEDGED / UNDELIVERED per human→agent line', async () => {
    const api = mock(async () => ({
      messages: [
        { type: 'instruction', message: 'a', timestamp: 1, state: 'queued' },
        { type: 'instruction', message: 'b', timestamp: 2, state: 'delivered' },
        { type: 'instruction', message: 'c', timestamp: 3, state: 'acknowledged' },
        { type: 'instruction', message: 'd', timestamp: 4, state: 'undelivered' },
        { type: 'response', message: 'e', timestamp: 5 },
      ],
    }));
    const result = await handleBuilddAction(api as unknown as ApiFn, 'get_task_messages', { taskId: TASK_ID }, context);
    const lines = (result.content[0]?.text ?? '').split('\n').filter(l => l.includes('[human→agent]'));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('QUEUED');
    expect(lines[1]).toContain('DELIVERED');
    expect(lines[2]).toContain('ACKNOWLEDGED');
    expect(lines[3]).toContain('UNDELIVERED');
    const agentLine = (result.content[0]?.text ?? '').split('\n').find(l => l.includes('[agent→human]'))!;
    expect(agentLine).not.toMatch(/QUEUED|DELIVERED|ACKNOWLEDGED/);
  });

  it('an older server without derived state still reads: pending is QUEUED', async () => {
    const api = mock(async () => ({
      messages: [{ type: 'instruction', message: 'a', timestamp: 1, deliveryState: 'pending' }],
    }));
    const result = await handleBuilddAction(api as unknown as ApiFn, 'get_task_messages', { taskId: TASK_ID }, context);
    expect(result.content[0]?.text).toContain('QUEUED');
  });
});
