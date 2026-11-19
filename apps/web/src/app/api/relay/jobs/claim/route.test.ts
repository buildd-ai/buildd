process.env.NODE_ENV = 'test';

// POST /api/relay/jobs/claim (docs/specs/local-runner-provider.md §4.1, AC-10).
import { describe, it, expect, beforeEach } from 'bun:test';
import { installRelayMocks, post, JOB, OTHER_RUNNER, RUNNER, TEAM } from '../relay-test-kit';

const kit = installRelayMocks();
const { POST } = await import('./route');

const claimed = {
  id: JOB, kind: 'embed', surface: 'query', model: 'nomic-embed-text',
  payload: { inputs: ['q'], inputType: 'query', dimensions: 768 },
  deadlineAt: '2026-11-14T00:00:20.000Z', leaseExpiresAt: '2026-11-14T00:01:00.000Z',
  leaseId: 'lease-1', leaseOwner: `${RUNNER}:lease-1`,
};
const body = (over: Record<string, unknown> = {}) => ({ runnerId: RUNNER, models: ['nomic-embed-text', 'llama3.1:8b'], ...over });
const callsOf = (fn: string) => kit.calls.filter(c => c.fn === fn);

beforeEach(() => {
  kit.account = { id: 'acc-1', teamId: TEAM, level: 'worker' };
  kit.ownRunnerIds = [RUNNER];
  kit.pick = { teamId: TEAM, runnerId: RUNNER, chatModel: 'llama3.1:8b', embeddingModel: 'nomic-embed-text', chatAssigned: true, runner: null };
  kit.calls.length = 0;
  kit.claim = async () => [];
  kit.sweep = async () => ({ expired: 0, requeued: 0, lost: 0, pruned: 0 });
});

describe('POST /api/relay/jobs/claim', () => {
  it('401 without a valid key, 403 for a trigger token', async () => {
    kit.account = null;
    expect((await POST(post('/api/relay/jobs/claim', body()))).status).toBe(401);
    kit.account = { id: 'acc-1', teamId: TEAM, level: 'trigger' };
    expect((await POST(post('/api/relay/jobs/claim', body()))).status).toBe(403);
    expect(callsOf('claimRelayJobs')).toHaveLength(0);
  });

  it('400 on a bad body: not JSON, no runnerId, models not a string array', async () => {
    expect((await POST(post('/api/relay/jobs/claim', '{nope'))).status).toBe(400);
    expect((await POST(post('/api/relay/jobs/claim', { models: ['a'] }))).status).toBe(400);
    expect((await POST(post('/api/relay/jobs/claim', body({ models: 'nomic' })))).status).toBe(400);
    expect((await POST(post('/api/relay/jobs/claim', body({ models: [1, 2] })))).status).toBe(400);
  });

  it('AC-10: a runnerId that is not the calling account\'s is 403 and nothing is claimed or swept', async () => {
    kit.ownRunnerIds = [];
    const res = await POST(post('/api/relay/jobs/claim', body({ runnerId: OTHER_RUNNER })));
    expect(res.status).toBe(403);
    expect(callsOf('claimRelayJobs')).toHaveLength(0);
    expect(callsOf('sweepRelayJobs')).toHaveLength(0);
  });

  it('hands out the jobs leased to this runner, scoped to its team, without the stored lease owner', async () => {
    kit.claim = async () => [claimed];
    const res = await POST(post('/api/relay/jobs/claim', body({ max: 3 })));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pollAfterMs).toBe(15_000);
    expect(json.jobs).toEqual([{
      id: JOB, kind: 'embed', model: 'nomic-embed-text', payload: claimed.payload,
      deadlineAt: claimed.deadlineAt, leaseExpiresAt: claimed.leaseExpiresAt, leaseId: 'lease-1',
    }]);
    expect(callsOf('claimRelayJobs')[0]!.args[0]).toEqual({ teamId: TEAM, runnerId: RUNNER, models: ['nomic-embed-text', 'llama3.1:8b'], max: 3 });
  });

  it('sweeps before it claims, so a requeued job is visible to this poll', async () => {
    await POST(post('/api/relay/jobs/claim', body()));
    expect(kit.calls.map(c => c.fn).filter(f => f === 'sweepRelayJobs' || f === 'claimRelayJobs')).toEqual(['sweepRelayJobs', 'claimRelayJobs']);
  });

  it('a failed sweep does not fail the claim', async () => {
    kit.sweep = async () => { throw new Error('db blip'); };
    kit.claim = async () => [claimed];
    const res = await POST(post('/api/relay/jobs/claim', body()));
    expect(res.status).toBe(200);
    expect((await res.json()).jobs).toHaveLength(1);
  });

  it('an empty claim is 200 with jobs: []', async () => {
    const res = await POST(post('/api/relay/jobs/claim', body()));
    expect(await res.json()).toEqual({ jobs: [], pollAfterMs: 15_000 });
  });

  it('default max: one job for a chat host, four for an embed-only host', async () => {
    await POST(post('/api/relay/jobs/claim', body()));
    expect((callsOf('claimRelayJobs')[0]!.args[0] as any).max).toBe(1);
    kit.calls.length = 0;
    kit.pick = { ...kit.pick!, chatAssigned: false };
    await POST(post('/api/relay/jobs/claim', body()));
    expect((callsOf('claimRelayJobs')[0]!.args[0] as any).max).toBe(4);
  });

  it('a runner the team does not pin (another runner pinned, or the pick removed) gets pollAfterMs 0 and no claim', async () => {
    kit.pick = { ...kit.pick!, runnerId: OTHER_RUNNER };
    let res = await POST(post('/api/relay/jobs/claim', body()));
    expect(await res.json()).toEqual({ jobs: [], pollAfterMs: 0 });
    kit.pick = { ...kit.pick!, runnerId: RUNNER, embeddingModel: null, chatAssigned: false };
    res = await POST(post('/api/relay/jobs/claim', body()));
    expect(await res.json()).toEqual({ jobs: [], pollAfterMs: 0 });
    expect(callsOf('claimRelayJobs')).toHaveLength(0);
  });

  it('model names that are not tags (a URL, an over-long string) are dropped; none left claims nothing', async () => {
    await POST(post('/api/relay/jobs/claim', body({ models: ['nomic-embed-text', 'http://127.0.0.1:11434', 'x'.repeat(200)] })));
    expect((callsOf('claimRelayJobs')[0]!.args[0] as any).models).toEqual(['nomic-embed-text']);
    kit.calls.length = 0;
    const res = await POST(post('/api/relay/jobs/claim', body({ models: [] })));
    expect(await res.json()).toEqual({ jobs: [], pollAfterMs: 15_000 });
    expect(callsOf('claimRelayJobs')).toHaveLength(0);
  });
});
