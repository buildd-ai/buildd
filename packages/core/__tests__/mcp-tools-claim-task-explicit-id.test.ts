/**
 * Regression tests for the friction report "claim_task can't target a
 * specific task, and an empty claim doesn't say why": claim_task now accepts
 * an optional taskId for an explicit pickup, and forwards the claim route's
 * diagnostics reason into the empty-claim message instead of a single
 * generic line.
 */

import { describe, it, expect, mock } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

const WORKSPACE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const TASK_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: WORKSPACE_ID,
    authType: 'api',
    getWorkspaceId: async () => WORKSPACE_ID,
    getLevel: async () => 'worker',
    ...overrides,
  };
}

describe('claim_task explicit taskId', () => {
  it('forwards taskId to the claim route', async () => {
    const api = mock(async () => ({ workers: [] }));

    await handleBuilddAction(api as unknown as ApiFn, 'claim_task', { taskId: TASK_ID }, ctx());

    expect(api).toHaveBeenCalledTimes(1);
    const [endpoint, options] = (api as any).mock.calls[0];
    expect(endpoint).toBe('/api/workers/claim');
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.taskId).toBe(TASK_ID);
  });

  it('rejects a non-UUID taskId with an actionable error', async () => {
    const api = mock(async () => ({ workers: [] }));

    await expect(
      handleBuilddAction(api as unknown as ApiFn, 'claim_task', { taskId: 'not-a-uuid' }, ctx()),
    ).rejects.toThrow(/full UUID/);
    expect(api).not.toHaveBeenCalled();
  });

  it('sets claimAcrossAccessible alongside taskId so the route\'s own ambiguous-workspace guard cannot 400 it', async () => {
    const api = mock(async () => ({ workers: [] }));

    await handleBuilddAction(
      api as unknown as ApiFn,
      'claim_task',
      { taskId: TASK_ID },
      ctx({ authType: 'oauth', workspaceId: undefined, getWorkspaceId: async () => null }),
    );

    const body = JSON.parse((api as any).mock.calls[0][1].body as string);
    expect(body.taskId).toBe(TASK_ID);
    expect(body.claimAcrossAccessible).toBe(true);
  });

  it('unwraps a 422 routing_mismatch error into a readable message', async () => {
    const api = mock(async () => {
      throw new Error(
        `API error: 422 - ${JSON.stringify({ error: 'routing_mismatch', detail: "role 'email-agent' connector requirements not met" })}`,
      );
    });

    const result = await handleBuilddAction(api as unknown as ApiFn, 'claim_task', { taskId: TASK_ID }, ctx());

    expect(result.isError).toBeTruthy();
    expect(result.content[0].text).toContain("role 'email-agent' connector requirements not met");
  });

  it('names the task in the empty-claim message and points to explain', async () => {
    const api = mock(async () => ({
      workers: [],
      diagnostics: { reason: 'no_pending_tasks', availableSlots: 1 },
    }));

    const result = await handleBuilddAction(api as unknown as ApiFn, 'claim_task', { taskId: TASK_ID }, ctx());

    const text = result.content[0].text;
    expect(text).toContain(TASK_ID);
    expect(text).toContain('was not claimed');
    expect(text).toContain(`action=explain with taskId=${TASK_ID}`);
  });
});

describe('claim_task diagnostics surfacing', () => {
  it('still returns the generic message when the route sends no diagnostics (legacy shape)', async () => {
    const api = mock(async () => ({ workers: [] }));

    const result = await handleBuilddAction(api as unknown as ApiFn, 'claim_task', {}, ctx());

    expect(result.content[0].text).toContain('No tasks available to claim');
  });

  it('reports the all_candidates_deferred breakdown', async () => {
    const api = mock(async () => ({
      workers: [],
      diagnostics: {
        reason: 'all_candidates_deferred',
        matchedTasks: 3,
        deferrals: { connector_mismatch: 2, mission_paced: 1 },
      },
    }));

    const result = await handleBuilddAction(api as unknown as ApiFn, 'claim_task', {}, ctx());

    const text = result.content[0].text;
    expect(text).toContain('connector mismatch (2)');
    expect(text).toContain('mission paced (1)');
  });

  it('reports budget_exhausted with the reset time', async () => {
    const api = mock(async () => ({
      workers: [],
      diagnostics: { reason: 'budget_exhausted' },
      budgetResetsAt: '2026-09-28T00:00:00.000Z',
    }));

    const result = await handleBuilddAction(api as unknown as ApiFn, 'claim_task', {}, ctx());

    const text = result.content[0].text;
    expect(text).toContain('budget is exhausted');
    expect(text).toContain('2026-09-28T00:00:00.000Z');
  });

  it('reports no_slots with the active/max counts', async () => {
    const api = mock(async () => ({
      workers: [],
      diagnostics: { reason: 'no_slots', activeWorkers: 3, maxConcurrent: 3 },
    }));

    const result = await handleBuilddAction(api as unknown as ApiFn, 'claim_task', {}, ctx());

    expect(result.content[0].text).toContain('3/3 active');
  });
});
