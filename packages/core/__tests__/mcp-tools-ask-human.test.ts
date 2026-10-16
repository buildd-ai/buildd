import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, workerActions, adminActions, type ApiFn, type ActionContext } from '../mcp-tools';
import { ACTION_TOKEN_SCOPE } from '../token-scopes';

/**
 * ask_human: an interactive session (claim_task from a person's Claude Code,
 * workers.runner = 'mcp') parks its own worker on a question. It reuses the
 * runner's park path, PATCH /api/workers/[id] with status waiting_input and a
 * question waitingFor, so Pusher, Needs You and the push all fire as they do
 * for a runner's AskUserQuestion.
 */

const WS_ID = '00000000-0000-0000-0000-000000000001';
const WORKER_ID = '22222222-2222-2222-2222-222222222222';

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workerId: WORKER_ID,
    workspaceId: WS_ID,
    getWorkspaceId: async () => WS_ID,
    getLevel: async () => 'worker',
    ...overrides,
  };
}

describe('ask_human', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('is a worker-level action a per-task token may call for its own worker', () => {
    expect(workerActions as readonly string[]).toContain('ask_human');
    expect(adminActions as readonly string[]).not.toContain('ask_human');
    expect(ACTION_TOKEN_SCOPE.ask_human).toBe('workers:write');
  });

  it('parks an interactive worker through the same PATCH the runner uses', async () => {
    mockApi
      .mockResolvedValueOnce({ id: WORKER_ID, runner: 'mcp', status: 'running' })
      .mockResolvedValueOnce({ id: WORKER_ID, status: 'waiting_input' });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'ask_human',
      { question: 'Ship behind a flag or straight on?', options: ['flag', 'straight'], context: 'Task fd: rollout of the new reaper rule.' },
      ctx(),
    );

    expect(mockApi).toHaveBeenCalledTimes(3);
    expect(mockApi.mock.calls[0][0]).toBe(`/api/workers/${WORKER_ID}`);
    const [endpoint, init] = mockApi.mock.calls[1];
    expect(endpoint).toBe(`/api/workers/${WORKER_ID}`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({
      status: 'waiting_input',
      waitingFor: {
        type: 'question',
        prompt: 'Ship behind a flag or straight on?',
        options: ['flag', 'straight'],
        context: 'Task fd: rollout of the new reaper rule.',
      },
    });

    expect(result.isError).toBeFalsy();
    const out = JSON.parse(result.content[0].text);
    expect(out.waiting).toBe(true);
    expect(out.workerId).toBe(WORKER_ID);
    expect(Number.isNaN(Date.parse(out.askedAt))).toBe(false);
    expect(out.hint).toContain('await_answer');
    expect(out.hint).toContain('receive_messages');
  });

  // Waiting costs nothing: the reply hands back a plain shell command the
  // session runs in the background; it exits when the person answers.
  it('hands back the wait command minted for this question', async () => {
    const waitCommand = "sh -c 'echo wait' buildd-wait 'https://buildd.dev/api/workers/x/answer/wait' 'bldw_p.m' 1760000000";
    mockApi
      .mockResolvedValueOnce({ id: WORKER_ID, runner: 'mcp', status: 'running' })
      .mockResolvedValueOnce({ id: WORKER_ID, status: 'waiting_input' })
      .mockResolvedValueOnce({ capability: 'bldw_p.m', waitUrl: 'https://buildd.dev/api/workers/x/answer/wait', waitCommand, expiresAt: '2026-10-12T10:00:00.000Z' });

    const result = await handleBuilddAction(mockApi as unknown as ApiFn, 'ask_human', { question: 'Which base?' }, ctx());

    const [endpoint, init] = mockApi.mock.calls[2];
    expect(endpoint).toBe(`/api/workers/${WORKER_ID}/answer/capability`);
    expect(init.method).toBe('POST');
    const out = JSON.parse(result.content[0].text);
    expect(out.waitCommand).toBe(waitCommand);
    expect(out.waitExpiresAt).toBe('2026-10-12T10:00:00.000Z');
    expect(out.hint).toContain('run_in_background');
    expect(out.hint).toContain('waitSeconds');
    // The session's own token never reaches the command.
    expect(out.waitCommand).not.toMatch(/\bbld[tp]?_/);
  });

  it('still parks, and falls back to await_answer, when no wait command can be minted', async () => {
    mockApi
      .mockResolvedValueOnce({ id: WORKER_ID, runner: 'mcp', status: 'running' })
      .mockResolvedValueOnce({ id: WORKER_ID, status: 'waiting_input' })
      .mockRejectedValueOnce(new Error('API error: 503 - wait_capability_unavailable'));
    const result = await handleBuilddAction(mockApi as unknown as ApiFn, 'ask_human', { question: 'Which base?' }, ctx());
    expect(result.isError).toBeFalsy();
    const out = JSON.parse(result.content[0].text);
    expect(out.waiting).toBe(true);
    expect(out.waitCommand).toBeUndefined();
    expect(out.hint).toContain('await_answer');
  });

  it('omits options and context when not given', async () => {
    mockApi
      .mockResolvedValueOnce({ id: WORKER_ID, runner: 'mcp', status: 'running' })
      .mockResolvedValueOnce({ id: WORKER_ID, status: 'waiting_input' });
    await handleBuilddAction(mockApi as unknown as ApiFn, 'ask_human', { question: 'Which base?' }, ctx());
    expect(JSON.parse(mockApi.mock.calls[1][1].body).waitingFor).toEqual({ type: 'question', prompt: 'Which base?' });
  });

  it('takes an explicit workerId', async () => {
    const other = '33333333-3333-3333-3333-333333333333';
    mockApi
      .mockResolvedValueOnce({ id: other, runner: 'mcp', status: 'running' })
      .mockResolvedValueOnce({ id: other, status: 'waiting_input' });
    await handleBuilddAction(mockApi as unknown as ApiFn, 'ask_human', { workerId: other, question: 'Q?' }, ctx({ workerId: undefined }));
    expect(mockApi.mock.calls[1][0]).toBe(`/api/workers/${other}`);
  });

  it('refuses a runner-managed worker and points at AskUserQuestion', async () => {
    mockApi.mockResolvedValueOnce({ id: WORKER_ID, runner: 'runner-host-1', status: 'running' });
    await expect(
      handleBuilddAction(mockApi as unknown as ApiFn, 'ask_human', { question: 'Q?' }, ctx()),
    ).rejects.toThrow('AskUserQuestion');
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  it('refuses a worker that has already ended', async () => {
    mockApi.mockResolvedValueOnce({ id: WORKER_ID, runner: 'mcp', status: 'completed' });
    await expect(
      handleBuilddAction(mockApi as unknown as ApiFn, 'ask_human', { question: 'Q?' }, ctx()),
    ).rejects.toThrow('completed');
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  it('requires a non-empty question and string options, before any call', async () => {
    await expect(
      handleBuilddAction(mockApi as unknown as ApiFn, 'ask_human', { question: '   ' }, ctx()),
    ).rejects.toThrow('question');
    await expect(
      handleBuilddAction(mockApi as unknown as ApiFn, 'ask_human', { question: 'Q?', options: ['a', 3] }, ctx()),
    ).rejects.toThrow('options');
    expect(mockApi).not.toHaveBeenCalled();
  });
});
