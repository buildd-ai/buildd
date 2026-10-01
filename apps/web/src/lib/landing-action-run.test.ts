import { describe, expect, it } from 'bun:test';
import { mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));
mock.module('@buildd/core/db/schema', () => ({ workspaces: {}, tasks: {} }));
mock.module('drizzle-orm', () => ({ eq: () => ({}), and: () => ({}), sql: () => ({}) }));
mock.module('@/lib/pr-landing-alert-deps', () => ({
  claimActionNonce: async () => true,
  readActionRecord: async () => null,
  releaseActionNonce: async () => {},
  settleActionNonce: async () => {},
  resetRefreshBudget: async () => {},
}));

const { makeLandingRunner } = await import('./landing-action-run');
import type { ActionContext } from './landing-action';

const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
  workspaceId: 'ws', prNumber: 7, taskId: 'task', workerId: 'wk', headSha: 'h1', reason: 'x', override: {}, ...over,
});

function harness(reply: any = { status: 200, json: { ok: true, taskId: 'new' } }, conflict: any = { dispatched: true, taskId: 'c1' }) {
  const log: string[] = [];
  const calls: any[] = [];
  const run = makeLandingRunner({
    async callRoute(name, pr, body) { log.push(`route:${name}`); calls.push({ name, pr, body }); return reply; },
    async dispatchConflict(c) { log.push('conflict'); calls.push({ conflict: c }); return conflict; },
    async closePr() { log.push('close'); },
    async resetBudget() { log.push('reset'); },
  });
  return { run, log, calls };
}

describe('makeLandingRunner', () => {
  it('ci_fix goes through the retry-ci door', async () => {
    const h = harness();
    expect(await h.run('ci_fix', ctx())).toMatchObject({ ok: true, taskId: 'new' });
    expect(h.log).toEqual(['route:retry-ci']);
    expect(h.calls[0].body).toEqual({ workspaceId: 'ws' });
  });
  it('re_review goes through the re-review door', async () => {
    const h = harness();
    await h.run('re_review', ctx());
    expect(h.log).toEqual(['route:re-review']);
  });
  it('conflict dispatches the resolver and reports its task', async () => {
    const h = harness();
    expect(await h.run('conflict', ctx())).toMatchObject({ ok: true, taskId: 'c1' });
    expect(h.log).toEqual(['conflict']);
  });
  it('conflict surfaces superseded and in-flight honestly', async () => {
    expect(await harness(undefined, { dispatched: false, superseded: true }).run('conflict', ctx())).toMatchObject({ ok: false });
    expect(await harness(undefined, { dispatched: false, inFlightTaskId: 'live' }).run('conflict', ctx())).toMatchObject({ ok: true, taskId: 'live' });
  });
  it('retry_landing restarts the budget before the merge door, with no overrides', async () => {
    const h = harness({ status: 200, json: { ok: true, merged: true } });
    expect(await h.run('retry_landing', ctx())).toMatchObject({ ok: true, outcome: 'merged' });
    expect(h.log).toEqual(['reset', 'route:merge']);
    expect(h.calls[0].body.overrides).toEqual({});
  });
  it('merge_anyway forwards exactly the override the reason allows and does not reset the budget', async () => {
    const h = harness({ status: 200, json: { ok: true, merged: true } });
    await h.run('merge_anyway', ctx({ override: { freshness: true } }));
    expect(h.log).toEqual(['route:merge']);
    expect(h.calls[0].body.overrides).toEqual({ freshness: true });
  });
  it('close_superseded closes the PR', async () => {
    const h = harness();
    expect(await h.run('close_superseded', ctx())).toMatchObject({ ok: true });
    expect(h.log).toEqual(['close']);
  });
});
