import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, workerActions, adminActions, type ApiFn, type ActionContext } from '../mcp-tools';
import { ACTION_TOKEN_SCOPE } from '../token-scopes';
import { ACTION_AREA, ACTION_LISTING, ACTION_SUMMARY } from '../mcp-tool-groups';

/**
 * await_answer: the session half of ask_human. The server long-polls
 * (POST /api/workers/[id]/answer, at most 45 s) until the parked question is
 * answered, reading the answer from its durable record; the tool then acks it
 * by id — the same ack receive_messages sends — so it is returned once.
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

const run = (api: ReturnType<typeof mock>, params: Record<string, unknown> = {}, c: ActionContext = ctx()) =>
  handleBuilddAction(api as unknown as ApiFn, 'await_answer', params, c);

describe('await_answer', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('is a worker-level action registered like ask_human', () => {
    expect(workerActions as readonly string[]).toContain('await_answer');
    expect(adminActions as readonly string[]).not.toContain('await_answer');
    expect(ACTION_TOKEN_SCOPE.await_answer).toBe('workers:write');
    expect(ACTION_AREA.await_answer).toBe('work');
    // Listed, not More: the consumer skills tell sessions to call it.
    expect(ACTION_LISTING.await_answer).toBe('listed');
    expect(ACTION_SUMMARY.await_answer).toBeTruthy();
  });

  it('returns the answer and acks it by id, once', async () => {
    mockApi
      .mockResolvedValueOnce({ state: 'answered', messageId: 'msg-1', text: 'Behind a flag.', question: 'Flag or straight on?', answeredAt: '2026-10-11T10:00:00.000Z', timedOut: false })
      .mockResolvedValueOnce({ ok: true });

    const result = await run(mockApi);

    const [endpoint, init] = mockApi.mock.calls[0];
    expect(endpoint).toBe(`/api/workers/${WORKER_ID}/answer`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ waitSeconds: 40 });

    const [ackEndpoint, ackInit] = mockApi.mock.calls[1];
    expect(ackEndpoint).toBe(`/api/workers/${WORKER_ID}`);
    expect(ackInit.method).toBe('PATCH');
    expect(JSON.parse(ackInit.body)).toEqual({ workerMessagesDelivered: ['msg-1'] });

    expect(result.isError).toBeFalsy();
    const out = JSON.parse(result.content[0].text);
    expect(out).toMatchObject({ answered: true, answer: 'Behind a flag.', question: 'Flag or straight on?', messageId: 'msg-1' });
  });

  it('still returns the answer when the ack fails (it is served again next call)', async () => {
    mockApi
      .mockResolvedValueOnce({ state: 'answered', messageId: 'msg-1', text: 'Yes.', question: null, timedOut: false })
      .mockRejectedValueOnce(new Error('500'));
    const out = JSON.parse((await run(mockApi)).content[0].text);
    expect(out.answered).toBe(true);
    expect(out.answer).toBe('Yes.');
  });

  it('on timeout says to call again', async () => {
    mockApi.mockResolvedValueOnce({ state: 'waiting', timedOut: true });
    const result = await run(mockApi);
    expect(mockApi).toHaveBeenCalledTimes(1);
    const out = JSON.parse(result.content[0].text);
    expect(out).toMatchObject({ answered: false, timedOut: true, stillWaiting: true });
    expect(out.hint).toContain('await_answer');
  });

  it('clamps waitSeconds to 0-45 before calling', async () => {
    mockApi.mockResolvedValue({ state: 'waiting', timedOut: true });
    await run(mockApi, { waitSeconds: 300 });
    await run(mockApi, { waitSeconds: -5 });
    await run(mockApi, { waitSeconds: 'soon' });
    await run(mockApi, { waitSeconds: 12 });
    const sent = mockApi.mock.calls.map(c => JSON.parse(c[1].body).waitSeconds);
    expect(sent).toEqual([45, 0, 40, 12]);
  });

  it('reports a session that is no longer waiting without long-polling again', async () => {
    mockApi.mockResolvedValueOnce({ state: 'not_waiting', reasonCode: 'session_ended', message: 'This worker has ended (superseded).', continuationTaskId: 'task-2', timedOut: false });
    const out = JSON.parse((await run(mockApi)).content[0].text);
    expect(out).toMatchObject({ answered: false, stillWaiting: false, reasonCode: 'session_ended', continuationTaskId: 'task-2' });
  });

  it('refuses a runner-managed worker', async () => {
    mockApi.mockResolvedValueOnce({ state: 'not_waiting', reasonCode: 'not_interactive', message: 'managed by a runner', timedOut: false });
    const result = await run(mockApi);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('runner');
  });

  it('takes an explicit workerId', async () => {
    const other = '33333333-3333-3333-3333-333333333333';
    mockApi.mockResolvedValueOnce({ state: 'waiting', timedOut: true });
    await run(mockApi, { workerId: other }, ctx({ workerId: undefined }));
    expect(mockApi.mock.calls[0][0]).toBe(`/api/workers/${other}/answer`);
  });
});
