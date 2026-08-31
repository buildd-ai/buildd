import { describe, expect, it, mock } from 'bun:test';
import {
  handleBuilddAction,
  type ActionContext,
  type ApiFn,
} from '../mcp-tools';

const WORKER_ID = 'worker-progress-1';

const context: ActionContext = {
  workerId: WORKER_ID,
  workspaceId: 'workspace-1',
  getWorkspaceId: async () => 'workspace-1',
  getLevel: async () => 'worker',
  authType: 'api',
};

describe('MCP update_progress', () => {
  it('records a plan through the worker PATCH endpoint with the progress update', async () => {
    const api = mock(async () => ({ status: 'running', progress: 25 }));

    const result = await handleBuilddAction(
      api as unknown as ApiFn,
      'update_progress',
      {
        progress: 25,
        message: 'Plan ready',
        plan: '1. Add regression test\n2. Fix progress routing',
      },
      context,
    );

    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0]?.[0]).toBe(`/api/workers/${WORKER_ID}`);
    expect(api.mock.calls[0]?.[1]?.method).toBe('PATCH');

    const body = JSON.parse(String(api.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      status: 'running',
      progress: 25,
      currentAction: 'Plan ready',
    });
    expect(body.appendMilestones).toEqual([
      {
        type: 'plan',
        label: '1. Add regression test\n2. Fix progress routing',
        progress: 25,
        ts: expect.any(Number),
      },
      {
        type: 'status',
        label: 'Plan ready',
        progress: 25,
        ts: expect.any(Number),
      },
    ]);
    expect(result.content[0]?.text).toContain('Progress updated: 25% - Plan ready');
  });

  // update_progress surfaces the served instruction in its tool result, so it is
  // a real consumer of the instruction queue. It has to declare that (otherwise
  // it only gets a read-only copy) and confirm delivery (otherwise the queue
  // stays pending and the same instruction repeats on every progress update).
  it('declares itself an instruction consumer', async () => {
    const api = mock(async () => ({ status: 'running' }));
    await handleBuilddAction(api as unknown as ApiFn, 'update_progress', { progress: 10 }, context);
    const body = JSON.parse(String(api.mock.calls[0]?.[1]?.body));
    expect(body.consumeInstructions).toBe(true);
  });

  it('confirms delivery of an instruction it surfaced to the agent', async () => {
    const api = mock(async () => ({
      status: 'running',
      instructions: 'Switch to the device flow',
      instructionsAck: 'Switch to the device flow',
    }));

    const result = await handleBuilddAction(
      api as unknown as ApiFn,
      'update_progress',
      { progress: 50 },
      context,
    );

    expect(result.content[0]?.text).toContain('ADMIN INSTRUCTION');
    expect(api).toHaveBeenCalledTimes(2);
    const ackBody = JSON.parse(String(api.mock.calls[1]?.[1]?.body));
    expect(ackBody.instructionsDelivered).toBe('Switch to the device flow');
  });

  it('sends no confirmation when nothing was served', async () => {
    const api = mock(async () => ({ status: 'running' }));
    await handleBuilddAction(api as unknown as ApiFn, 'update_progress', { progress: 50 }, context);
    expect(api).toHaveBeenCalledTimes(1);
  });
});
