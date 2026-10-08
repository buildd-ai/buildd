import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, workerActions, type ApiFn, type ActionContext } from '../mcp-tools';
import { ACTION_AREA } from '../mcp-tool-groups';

const WS = '00000000-0000-0000-0000-000000000001';
const WORKER = '00000000-0000-0000-0000-000000000002';
const TASK = '00000000-0000-0000-0000-000000000003';
const RETRY = '00000000-0000-0000-0000-000000000004';
const EV = '00000000-0000-0000-0000-0000000000e1';
const EV_OLD = '00000000-0000-0000-0000-0000000000e2';

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: WS,
    workerId: WORKER,
    authType: 'oauth',
    getWorkspaceId: async () => WS,
    getLevel: async () => 'worker',
    ...overrides,
  };
}

const obj = (over: Record<string, unknown> = {}) => ({
  id: EV, workspaceId: WS, taskId: TASK, rootTaskId: TASK, workerId: WORKER, prNumber: null,
  kind: 'ci_job_log', bytes: 4096, uploadState: 'stored', indexState: 'skipped',
  createdAt: '2026-09-30T00:00:00.000Z', expiresAt: null, ...over,
});

const readResponse = (over: Record<string, unknown> = {}) => ({
  taskId: RETRY, workspaceId: WS, object: obj({ taskId: RETRY }), text: '12:FAIL x\n40:FAIL y',
  truncated: false, cursor: null, fromLine: 12, toLine: 40, lineCount: 2, scannedLines: 90, scanLimited: false, ...over,
});

describe('read_evidence registration', () => {
  it('is a worker-level action in the workers area', () => {
    expect((workerActions as readonly string[]).includes('read_evidence')).toBe(true);
    expect(ACTION_AREA.read_evidence).toBe('workers');
  });
});

describe('read_evidence', () => {
  let api: ReturnType<typeof mock>;
  beforeEach(() => { api = mock(); });
  const call = (params: Record<string, unknown>) => handleBuilddAction(api as unknown as ApiFn, 'read_evidence', params, ctx());

  it('refuses a call with no subject', async () => {
    const res = await call({});
    expect(res.isError).toBe(true);
    expect(api).not.toHaveBeenCalled();
  });

  it('lists a task\'s objects when nothing asks for text', async () => {
    api.mockResolvedValueOnce({ taskId: TASK, workspaceId: WS, objects: [obj()] });
    const res = await call({ taskId: TASK, kind: 'ci_job_log' });
    expect(api.mock.calls[0][0]).toBe(`/api/tasks/${TASK}/evidence?kind=ci_job_log`);
    expect(res.content[0].text).toContain(EV);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('AC-5: prNumber + kind + grep resolves the PR, then reads the newest stored object through its task', async () => {
    api
      .mockResolvedValueOnce({ workspaceId: WS, prNumber: 7, taskIds: [RETRY], objects: [obj({ id: EV, taskId: RETRY }), obj({ id: EV_OLD })] })
      .mockResolvedValueOnce(readResponse());
    const res = await call({ prNumber: 7, kind: 'ci_job_log', grep: 'fail' });
    expect(api.mock.calls[0][0]).toBe(`/api/evidence?workspaceId=${WS}&prNumber=7&kind=ci_job_log`);
    const second = new URL(`http://x${api.mock.calls[1][0]}`);
    expect(second.pathname).toBe(`/api/tasks/${RETRY}/evidence`);
    expect(second.searchParams.get('evidenceId')).toBe(EV);
    expect(second.searchParams.get('grep')).toBe('fail');
    expect(res.content[0].text).toContain('12:FAIL x');
    expect(res.content[0].text).toContain('1 other object');
  });

  it("evidenceId alone reads a Scout run's command log through the run, not a task", async () => {
    const RUN = '00000000-0000-0000-0000-0000000000a1';
    api
      .mockResolvedValueOnce({ workspaceId: WS, prNumber: null, taskIds: [], objects: [obj({ taskId: null, rootTaskId: null, workerId: null, scoutRunId: RUN, kind: 'command_output' })] })
      .mockResolvedValueOnce(readResponse({ taskId: undefined, scoutRunId: RUN, object: obj({ taskId: null, scoutRunId: RUN, kind: 'command_output' }), text: 'FAIL probe' }));
    const res = await call({ evidenceId: EV, tail: 20 });
    expect(api.mock.calls[0][0]).toBe(`/api/evidence?workspaceId=${WS}&evidenceId=${EV}`);
    const second = new URL(`http://x${api.mock.calls[1][0]}`);
    expect(second.pathname).toBe(`/api/quality-scout/runs/${RUN}/evidence`);
    expect(second.searchParams.get('evidenceId')).toBe(EV);
    expect(second.searchParams.get('tail')).toBe('20');
    expect(res.content[0].text).toContain(`scout run ${RUN}`);
    expect(res.content[0].text).toContain('FAIL probe');
  });

  it('skips objects that are not stored', async () => {
    api
      .mockResolvedValueOnce({ taskId: TASK, workspaceId: WS, objects: [obj({ id: EV_OLD, uploadState: 'failed' }), obj()] })
      .mockResolvedValueOnce(readResponse());
    await call({ taskId: TASK, tail: 50 });
    const second = new URL(`http://x${api.mock.calls[1][0]}`);
    expect(second.pathname).toBe(`/api/tasks/${TASK}/evidence`);
    expect(second.searchParams.get('evidenceId')).toBe(EV);
    expect(second.searchParams.get('tail')).toBe('50');
  });

  it('says when a read was truncated and hands back the cursor', async () => {
    api
      .mockResolvedValueOnce({ taskId: TASK, workspaceId: WS, objects: [obj()] })
      .mockResolvedValueOnce(readResponse({ truncated: true, cursor: '812' }));
    const res = await call({ taskId: TASK, grep: 'x' });
    expect(res.content[0].text).toContain('TRUNCATED at 64 KB: continue with cursor=812');
  });

  it('evidenceId alone finds its task through the workspace lookup, then reads', async () => {
    api
      .mockResolvedValueOnce({ workspaceId: WS, prNumber: null, taskIds: [RETRY], objects: [obj({ taskId: RETRY })] })
      .mockResolvedValueOnce(readResponse());
    await call({ evidenceId: EV });
    expect(api.mock.calls[0][0]).toBe(`/api/evidence?workspaceId=${WS}&evidenceId=${EV}`);
    expect(api.mock.calls[1][0]).toBe(`/api/tasks/${RETRY}/evidence?evidenceId=${EV}`);
  });

  it('never surfaces a URL', async () => {
    api
      .mockResolvedValueOnce({ taskId: TASK, workspaceId: WS, objects: [obj()] })
      .mockResolvedValueOnce(readResponse());
    const res = await call({ taskId: TASK, tail: 5 });
    expect(res.content[0].text).not.toMatch(/https?:\/\//);
  });
});
