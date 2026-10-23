import { describe, it, expect, mock } from 'bun:test';

// No database: the scope, the decision run and the save are injected.
mock.module('@buildd/core/db', () => ({ db: {} }));
mock.module('@/lib/github', () => ({ githubApi: async () => null, githubApiText: async () => '', getInstallationToken: async () => 't' }));

const { judgeRedCheck } = await import('./red-check-decision');
type Deps = NonNullable<Parameters<typeof judgeRedCheck>[1]>;
type Response = Awaited<ReturnType<NonNullable<Deps['run']>>>;

const event = {
  type: 'pr.red_check_unclassified' as const,
  repoFullName: 'o/r', prNumber: 5, headSha: 'h1', signature: 'sig',
  jobs: [{ name: 'e2e', step: 'Run e2e', lines: 'Error: page.goto: net::ERR_CONNECTION_RESET' }],
};
const answer = (over: Partial<Response>): Response => ({
  decision: 'environment', confidence: 0.92, source: 'model', mode: 'live', model: 'jev', reasonCode: 'cause_environment', policyVersion: 'redcause-1', ...over,
});

function deps(response: Response | (() => Promise<Response>), saved = true) {
  const saves: unknown[] = [];
  const runs: unknown[][] = [];
  const d: Deps = {
    scope: async () => ({ teamId: 't1', workspaceId: 'w1', taskId: 'task1' }),
    run: async (...args) => { runs.push(args); return typeof response === 'function' ? response() : response; },
    save: async (_input, j) => { saves.push(j); return saved; },
    now: () => new Date('2026-10-23T09:00:00Z'),
  };
  return { d, saves, runs };
}

describe('judgeRedCheck (surface-ia §11 R-3)', () => {
  it('asks the kind in the owner\'s team and stores the model\'s answer for this failure', async () => {
    const { d, saves, runs } = deps(answer({}));
    const j = await judgeRedCheck(event, d);
    expect(j).toEqual({ decision: 'environment', confidence: 0.92, source: 'model', model: 'jev', reasonCode: 'cause_environment', policyVersion: 'redcause-1', signature: 'sig', at: '2026-10-23T09:00:00.000Z' });
    expect(saves).toEqual([j]);
    expect(runs[0][1]).toMatchObject({ features: { jobs: event.jobs }, subjectRef: { type: 'pr', id: 'o/r#5@h1' } });
    expect(runs[0][2]).toEqual({ teamId: 't1', workspaceId: 'w1', taskId: 'task1' });
  });

  it('a fallback is stored as the code, so the head is not asked again for it', async () => {
    const { d, saves } = deps(answer({ decision: 'code', confidence: null, source: 'fallback', model: null, reasonCode: 'fallback_low_confidence' }));
    expect((await judgeRedCheck(event, d))?.decision).toBe('code');
    expect(saves).toHaveLength(1);
  });

  it('a team with the capability off stores nothing', async () => {
    const { d, saves } = deps(answer({ decision: 'code', mode: 'disabled', source: 'fallback' }));
    expect(await judgeRedCheck(event, d)).toBeNull();
    expect(saves).toHaveLength(0);
  });

  it('no owner task: nothing is asked', async () => {
    const { d, runs } = deps(answer({}));
    expect(await judgeRedCheck(event, { ...d, scope: async () => null })).toBeNull();
    expect(runs).toHaveLength(0);
  });

  it('a record that moved on keeps its own reading, and a throw never escapes', async () => {
    expect(await judgeRedCheck(event, deps(answer({}), false).d)).toBeNull();
    expect(await judgeRedCheck(event, deps(async () => { throw new Error('boom'); }).d)).toBeNull();
  });
});
