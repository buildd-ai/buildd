process.env.NODE_ENV = 'test';

// POST /api/relay/jobs/[id]/result (docs/specs/local-runner-provider.md §4.2, AC-11, AC-12).
import { describe, it, expect, beforeEach } from 'bun:test';
import { installRelayMocks, post, JOB, OTHER_RUNNER, RUNNER, TEAM } from '../../relay-test-kit';

const kit = installRelayMocks();
const { POST } = await import('./route');

const path = `/api/relay/jobs/${JOB}/result`;
const ctx = (id = JOB) => ({ params: Promise.resolve({ id }) });
const okBody = { runnerId: RUNNER, leaseId: 'lease-1', ok: true, result: { vectors: [[0.1, 0.2]], dimensions: 2, model: 'm' } };
const completes = () => kit.calls.filter(c => c.fn === 'completeRelayJob');

beforeEach(() => {
  kit.account = { id: 'acc-1', teamId: TEAM, level: 'worker' };
  kit.ownRunnerIds = [RUNNER];
  kit.calls.length = 0;
  kit.complete = async () => ({ outcome: 'done' });
});

describe('POST /api/relay/jobs/[id]/result', () => {
  it('401 without a key, 403 for a trigger token, 403 for another account\'s runner (nothing written)', async () => {
    kit.account = null;
    expect((await POST(post(path, okBody), ctx())).status).toBe(401);
    kit.account = { id: 'acc-1', teamId: TEAM, level: 'trigger' };
    expect((await POST(post(path, okBody), ctx())).status).toBe(403);
    kit.account = { id: 'acc-1', teamId: TEAM, level: 'worker' };
    kit.ownRunnerIds = [];
    expect((await POST(post(path, { ...okBody, runnerId: OTHER_RUNNER }), ctx())).status).toBe(403);
    expect(completes()).toHaveLength(0);
  });

  it('400 on a malformed job id, a missing leaseId, a non-boolean ok, an ok without a result, an unknown error code', async () => {
    expect((await POST(post(path, okBody), ctx('not-a-uuid'))).status).toBe(400);
    expect((await POST(post(path, { ...okBody, leaseId: '' }), ctx())).status).toBe(400);
    expect((await POST(post(path, { ...okBody, ok: 'yes' }), ctx())).status).toBe(400);
    expect((await POST(post(path, { runnerId: RUNNER, leaseId: 'l', ok: true }), ctx())).status).toBe(400);
    expect((await POST(post(path, { runnerId: RUNNER, leaseId: 'l', ok: false, error: { code: 'made_up', message: 'x' } }), ctx())).status).toBe(400);
    expect(completes()).toHaveLength(0);
  });

  it('stores a result under the lease this runner holds', async () => {
    const res = await POST(post(path, okBody), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'done' });
    expect(completes()[0]!.args[0]).toEqual({ id: JOB, leaseOwner: `${RUNNER}:lease-1`, ok: true, result: okBody.result });
  });

  it('AC-12: a result the store fails on validation answers 200 failed with the code', async () => {
    kit.complete = async () => ({ outcome: 'failed', error: { code: 'dimension_mismatch', message: 'vector 0 has 2 dimensions' } });
    const res = await POST(post(path, okBody), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'failed', error: { code: 'dimension_mismatch', message: 'vector 0 has 2 dimensions' } });
  });

  it('passes a runner error through with its http status, message bounded', async () => {
    kit.complete = async () => ({ outcome: 'requeued', notBeforeMs: 10_000 });
    const res = await POST(post(path, { runnerId: RUNNER, leaseId: 'lease-1', ok: false, error: { code: 'ollama_error', message: 'x'.repeat(5_000), httpStatus: 503, extra: 'dropped' } }), ctx());
    expect(await res.json()).toEqual({ status: 'requeued', notBeforeMs: 10_000 });
    const sent = completes()[0]!.args[0] as any;
    expect(sent.error.code).toBe('ollama_error');
    expect(sent.error.httpStatus).toBe(503);
    expect(sent.error.message.length).toBe(2_000);
    expect(sent.error.extra).toBeUndefined();
  });

  it('AC-11: a lease held by another owner is 409', async () => {
    kit.complete = async () => ({ outcome: 'conflict' });
    expect((await POST(post(path, okBody), ctx())).status).toBe(409);
  });

  it('a cancelled or expired job is 410; a job that does not exist is 404', async () => {
    kit.complete = async () => ({ outcome: 'gone', status: 'cancelled' });
    const gone = await POST(post(path, okBody), ctx());
    expect(gone.status).toBe(410);
    expect((await gone.json()).status).toBe('cancelled');
    kit.complete = async () => ({ outcome: 'gone', status: null });
    expect((await POST(post(path, okBody), ctx())).status).toBe(404);
  });
});
