import { describe, expect, it, mock } from 'bun:test';
import {
  handleBuilddAction,
  type ActionContext,
  type ApiFn,
} from '../mcp-tools';

const WORKER_ID = 'worker-hint-1';

const context: ActionContext = {
  workerId: WORKER_ID,
  workspaceId: 'workspace-1',
  getWorkspaceId: async () => 'workspace-1',
  getLevel: async () => 'worker',
  authType: 'api',
};

/**
 * handleBuilddAction runs a write-fence pre-flight GET on the worker before
 * dispatching to the action, and complete_task follows its own PATCH with a
 * GET for release/task data — so the PATCH is never call index 0. Find it by
 * its method instead of assuming a position.
 */
function patchBody(api: ReturnType<typeof mock>): any {
  const patchCall = api.mock.calls.find(c => (c[1] as { method?: string } | undefined)?.method === 'PATCH');
  return JSON.parse(String((patchCall?.[1] as { body?: string } | undefined)?.body));
}

describe('MCP complete_task — 400 hint handling', () => {
  it('does not tell the agent to call a hint that names no real action', async () => {
    const api = mock(async () => {
      throw new Error(
        'API error: 400 - {"error":"This task has dependent(s) waiting on it. You must include `handoff.delivered` in your structured output (`structuredOutput.handoff.delivered`) with a one-line summary of what you delivered before completing.","hint":"handoff_required"}',
      );
    });

    const result = await handleBuilddAction(
      api as unknown as ApiFn,
      'complete_task',
      { summary: 'done' },
      context,
    );

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    // The gate's own error text already names the real parameter — must survive.
    expect(text).toContain('structuredOutput.handoff.delivered');
    // Must not invent a fake tool call named after the gate slug.
    expect(text).not.toContain('use `handoff_required`');
  });

  it('still tells the agent to use create_pr when the hint names a real action', async () => {
    const api = mock(async () => {
      throw new Error(
        'API error: 400 - {"error":"This task requires a pull request before completing. Use create_pr to open one.","hint":"create_pr"}',
      );
    });

    const result = await handleBuilddAction(
      api as unknown as ApiFn,
      'complete_task',
      { summary: 'done' },
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Please use `create_pr` before calling complete_task again.');
  });

  it('still tells the agent to use create_pr or create_artifact for a compound hint', async () => {
    const api = mock(async () => {
      throw new Error(
        'API error: 400 - {"error":"This task requires a deliverable before completing. Use create_pr or create_artifact.","hint":"create_pr or create_artifact"}',
      );
    });

    const result = await handleBuilddAction(
      api as unknown as ApiFn,
      'complete_task',
      { summary: 'done' },
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Please use `create_pr or create_artifact` before calling complete_task again.');
  });
});

describe('MCP complete_task — self-reported usage', () => {
  it('forwards inputTokens/outputTokens/costUsd to the worker PATCH', async () => {
    const api = mock(async () => ({ turns: 1 }));

    await handleBuilddAction(
      api as unknown as ApiFn,
      'complete_task',
      { summary: 'done', inputTokens: 1200, outputTokens: 340, costUsd: 0.42 },
      context,
    );

    const body = patchBody(api);
    expect(body.inputTokens).toBe(1200);
    expect(body.outputTokens).toBe(340);
    expect(body.costUsd).toBe(0.42);
  });

  it('omits usage fields entirely when not provided', async () => {
    const api = mock(async () => ({ turns: 1 }));

    await handleBuilddAction(
      api as unknown as ApiFn,
      'complete_task',
      { summary: 'done' },
      context,
    );

    const body = patchBody(api);
    expect(body.inputTokens).toBeUndefined();
    expect(body.outputTokens).toBeUndefined();
    expect(body.costUsd).toBeUndefined();
  });
});

describe('MCP complete_task — marks the PATCH as the agent\'s own call', () => {
  it('sends viaCompleteTask so the server can refuse (not fail) a fixable verdict', async () => {
    const api = mock(async () => ({ status: 'completed', turns: 1 }));
    await handleBuilddAction(api as unknown as ApiFn, 'complete_task', { summary: 'done' }, context);
    expect(patchBody(api).viaCompleteTask).toBe(true);
  });
});

describe('MCP complete_task — server overrode the completion', () => {
  it('reports a worker the server wrote back as failed instead of "completed successfully"', async () => {
    const api = mock(async (_path: string, init?: { method?: string }) =>
      init?.method === 'PATCH'
        ? { id: WORKER_ID, status: 'failed', error: 'Review task completed without structuredOutput.verdict: the verdict was returned as prose and dropped' }
        : { id: WORKER_ID },
    );

    const result = await handleBuilddAction(
      api as unknown as ApiFn,
      'complete_task',
      { summary: 'Verdict: approve' },
      context,
    );

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).not.toContain('Task completed successfully');
    expect(text).toContain('NOT recorded as completed');
    expect(text).toContain('verdict was returned as prose and dropped');
  });

  it('still reports success when the PATCH echoes a completed worker', async () => {
    const api = mock(async () => ({ status: 'completed', turns: 1 }));

    const result = await handleBuilddAction(
      api as unknown as ApiFn,
      'complete_task',
      { summary: 'done' },
      context,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Task completed successfully');
  });
});

describe('MCP update_progress — self-reported cost', () => {
  it('forwards costUsd to the worker PATCH alongside token counts', async () => {
    const api = mock(async () => ({ status: 'running' }));

    await handleBuilddAction(
      api as unknown as ApiFn,
      'update_progress',
      { progress: 50, inputTokens: 500, outputTokens: 100, costUsd: 0.05 },
      context,
    );

    const body = patchBody(api);
    expect(body.inputTokens).toBe(500);
    expect(body.outputTokens).toBe(100);
    expect(body.costUsd).toBe(0.05);
  });
});

describe('MCP complete_task — 409 on a worker the server already finished', () => {
  it('a completed task whose local slot was released is not reported as an error', async () => {
    const api = mock(async () => {
      throw new Error('API error: 409 - {"error":"Worker already completed","abort":true,"reason":"completed","actualStatus":"completed"}');
    });
    const result = await handleBuilddAction(api as unknown as ApiFn, 'complete_task', { summary: 'done' }, context);

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('slot was released');
  });

  it('a terminated worker still gets the warning', async () => {
    const api = mock(async () => {
      throw new Error('API error: 409 - {"error":"Worker was terminated - task may have been reassigned","abort":true}');
    });
    const result = await handleBuilddAction(api as unknown as ApiFn, 'complete_task', { summary: 'done' }, context);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already terminated');
  });
});
