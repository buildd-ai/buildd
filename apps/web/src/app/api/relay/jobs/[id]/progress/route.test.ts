process.env.NODE_ENV = 'test';

// POST /api/relay/jobs/[id]/progress (docs/specs/local-runner-provider.md §4.5).
import { describe, it, expect, beforeEach } from 'bun:test';
import { installRelayMocks, post, JOB, OTHER_RUNNER, RUNNER, TEAM } from '../../relay-test-kit';

const kit = installRelayMocks();
const { POST } = await import('./route');

const path = `/api/relay/jobs/${JOB}/progress`;
const ctx = (id = JOB) => ({ params: Promise.resolve({ id }) });
const body = (over: Record<string, unknown> = {}) => ({ runnerId: RUNNER, leaseId: 'lease-1', ...over });
const progresses = () => kit.calls.filter(c => c.fn === 'progressRelayJob');

beforeEach(() => {
  kit.account = { id: 'acc-1', teamId: TEAM, level: 'worker' };
  kit.ownRunnerIds = [RUNNER];
  kit.calls.length = 0;
  kit.progress = async () => true;
  kit.job = null;
});

describe('POST /api/relay/jobs/[id]/progress', () => {
  it('401, 403 trigger, 403 for a runner that is not the caller\'s', async () => {
    kit.account = null;
    expect((await POST(post(path, body()), ctx())).status).toBe(401);
    kit.account = { id: 'acc-1', teamId: TEAM, level: 'trigger' };
    expect((await POST(post(path, body()), ctx())).status).toBe(403);
    kit.account = { id: 'acc-1', teamId: TEAM, level: 'worker' };
    kit.ownRunnerIds = [];
    expect((await POST(post(path, body({ runnerId: OTHER_RUNNER })), ctx())).status).toBe(403);
    expect(progresses()).toHaveLength(0);
  });

  it('400 on a bad job id, a missing leaseId, a partialText that is not a string', async () => {
    expect((await POST(post(path, body()), ctx('nope'))).status).toBe(400);
    expect((await POST(post(path, { runnerId: RUNNER }), ctx())).status).toBe(400);
    expect((await POST(post(path, body({ partialText: 42 })), ctx())).status).toBe(400);
  });

  it('renews the lease, with and without partial text', async () => {
    let res = await POST(post(path, body()), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(progresses()[0]!.args[0]).toEqual({ id: JOB, leaseOwner: `${RUNNER}:lease-1` });
    res = await POST(post(path, body({ partialText: 'Hel' })), ctx());
    expect(progresses()[1]!.args[0]).toEqual({ id: JOB, leaseOwner: `${RUNNER}:lease-1`, partialText: 'Hel' });
  });

  it('a lease this runner no longer holds: 409 while the job is open, 410 once terminal, 404 when gone', async () => {
    kit.progress = async () => false;
    kit.job = { id: JOB, status: 'leased' };
    expect((await POST(post(path, body()), ctx())).status).toBe(409);
    kit.job = { id: JOB, status: 'cancelled' };
    expect((await POST(post(path, body()), ctx())).status).toBe(410);
    kit.job = null;
    expect((await POST(post(path, body()), ctx())).status).toBe(404);
  });
});
