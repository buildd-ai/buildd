import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { runLandingAction, describeLandingAction, fromDispatchRoute, fromMergeRoute, type LandingActionDeps, type ActionContext } from './landing-action';
import { signLandingActionToken, LANDING_ACTION_TTL_MS, type LandingAction } from './landing-action-token';
import { actionsForReason } from './pr-landing-alert';

const NOW = 1_800_000_000_000;
const TASK = 'task-1';

function fakeDeps(over: Partial<LandingActionDeps> = {}) {
  const records = new Map<string, any>();
  const calls: Array<{ action: LandingAction; ctx: ActionContext }> = [];
  const deps: LandingActionDeps = {
    now: () => NOW,
    async claimNonce(_t, nonce, rec) {
      if (records.has(nonce)) return false;
      records.set(nonce, rec);
      return true;
    },
    async readNonce(_t, nonce) {
      return records.get(nonce) ?? null;
    },
    async settleNonce(_t, nonce, rec) {
      records.set(nonce, rec);
    },
    async releaseNonce(_t, nonce) {
      records.delete(nonce);
    },
    async readLiveHead() {
      return 'head1';
    },
    async run(action, ctx) {
      calls.push({ action, ctx });
      return { ok: true, summary: `ran ${action}`, taskId: 'new-task' };
    },
    ...over,
  };
  return { deps, calls, records };
}

const sign = (reason: string, action?: LandingAction, over: Record<string, unknown> = {}) =>
  signLandingActionToken(
    { workspaceId: 'ws-1', prNumber: 42, headSha: 'head1', action: action ?? actionsForReason(reason).primary, reason, ...over } as any,
    NOW,
  )!;

const ctxIn = { taskId: TASK, workerId: 'w-1', workspaceId: 'ws-1' };
const tapped = (token: string, action?: LandingAction) => ({ token, action, ...ctxIn, prNumber: 42 });

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = 'test-secret';
});
afterEach(() => {
  if (saved === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = saved;
});

describe('runLandingAction: one tap dispatches the right fix', () => {
  it.each([
    ['fix_stuck:ci_fix', 'ci_fix'],
    ['fix_stuck:conflict', 'conflict'],
    ['fix_stuck:renumber_migration', 'conflict'],
    ['fix_stuck:re_review', 're_review'],
    ['needs_human:fix_exhausted', 'conflict'],
    ['needs_human:refresh_exhausted', 'retry_landing'],
    ['needs_human:blocking_verdict', 're_review'],
    ['needs_human:superseded', 'close_superseded'],
    ['invariant', 'retry_landing'],
  ])('%s → %s, exactly once', async (reason, kind) => {
    const { deps, calls } = fakeDeps();
    const res = await runLandingAction(tapped(sign(reason)), deps);
    expect(res).toMatchObject({ status: 'done', ok: true, stale: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.action).toBe(kind);
    expect(calls[0]!.ctx).toMatchObject({ workspaceId: 'ws-1', prNumber: 42, taskId: TASK, workerId: 'w-1', headSha: 'head1', reason });
  });

  it('runs the option the person picked on the confirm screen when the page offers it', async () => {
    const { deps, calls } = fakeDeps();
    const res = await runLandingAction(tapped(sign('needs_human:fix_exhausted'), 'close_superseded'), deps);
    expect(res).toMatchObject({ status: 'done', ok: true });
    expect(calls.map((c) => c.action)).toEqual(['close_superseded']);
  });

  it('merge anyway carries the override the cause allows, and nothing broader', async () => {
    const { deps, calls } = fakeDeps();
    await runLandingAction(tapped(sign('needs_human:refresh_exhausted'), 'merge_anyway'), deps);
    expect(calls[0]!.ctx.override).toEqual({ freshness: true });
  });

  it.each([
    ['needs_human:deny_path', 'merge_anyway'],
    ['fix_stuck:ci_fix', 'merge_anyway'],
    ['fix_stuck:ci_fix', 'close_superseded'],
    ['needs_human:refresh_exhausted', 'ci_fix'],
  ] as const)('refuses an action the reason does not offer: %s / %s', async (reason, action) => {
    const { deps, calls, records } = fakeDeps();
    const res = await runLandingAction(tapped(sign(reason), action), deps);
    expect(res).toMatchObject({ status: 'rejected', code: 'bad_action', httpStatus: 400 });
    expect(calls).toHaveLength(0);
    expect(records.size).toBe(0);
  });
});

describe('runLandingAction: the signed link', () => {
  it('rejects an expired link and acts on nothing', async () => {
    const { deps, calls } = fakeDeps({ now: () => NOW + LANDING_ACTION_TTL_MS });
    const res = await runLandingAction(tapped(sign('fix_stuck:ci_fix')), deps);
    expect(res).toMatchObject({ status: 'rejected', code: 'expired', httpStatus: 410 });
    expect(calls).toHaveLength(0);
  });

  it('rejects a replayed link: the second confirm shows "already done" with the first result and acts once', async () => {
    const { deps, calls } = fakeDeps();
    const token = sign('fix_stuck:ci_fix');
    const first = await runLandingAction(tapped(token), deps);
    const second = await runLandingAction(tapped(token), deps);
    expect(first.status).toBe('done');
    expect(second).toMatchObject({ status: 'already_done', result: { summary: 'ran ci_fix', taskId: 'new-task' } });
    expect(calls).toHaveLength(1);
  });

  it('two simultaneous taps act once', async () => {
    const { deps, calls } = fakeDeps();
    const token = sign('fix_stuck:ci_fix');
    const [a, b] = await Promise.all([runLandingAction(tapped(token), deps), runLandingAction(tapped(token), deps)]);
    expect(calls).toHaveLength(1);
    expect([a.status, b.status].sort()).toEqual(['done', 'in_progress']);
  });

  it.each([
    ['a tampered token', (t: string) => t.slice(0, -2) + (t.endsWith('aa') ? 'bb' : 'aa')],
    ['garbage', () => 'not-a-token'],
    ['empty', () => ''],
  ])('rejects %s', async (_n, mangle) => {
    const { deps, calls } = fakeDeps();
    const res = await runLandingAction(tapped(mangle(sign('fix_stuck:ci_fix'))), deps);
    expect(res).toMatchObject({ status: 'rejected', httpStatus: 400 });
    expect(calls).toHaveLength(0);
  });

  it('a token for another PR or workspace never acts, even from a signed-in member', async () => {
    const { deps, calls } = fakeDeps();
    expect(await runLandingAction({ ...tapped(sign('fix_stuck:ci_fix')), prNumber: 43 }, deps)).toMatchObject({ status: 'rejected', code: 'mismatch', httpStatus: 403 });
    expect(await runLandingAction({ ...tapped(sign('fix_stuck:ci_fix')), workspaceId: 'ws-2' }, deps)).toMatchObject({ status: 'rejected', code: 'mismatch' });
    expect(calls).toHaveLength(0);
  });

  it('frees the link when the action fails so the person can tap again', async () => {
    let fail = true;
    const { deps, calls } = fakeDeps({
      async run(action, ctx) {
        calls.push({ action, ctx });
        return fail ? { ok: false, error: 'GitHub is down' } : { ok: true, summary: 'ok' };
      },
    });
    const token = sign('fix_stuck:ci_fix');
    expect(await runLandingAction(tapped(token), deps)).toMatchObject({ status: 'done', ok: false, error: 'GitHub is down' });
    fail = false;
    expect(await runLandingAction(tapped(token), deps)).toMatchObject({ status: 'done', ok: true });
  });

  it('frees the link when the action throws', async () => {
    const { deps } = fakeDeps({
      async run() {
        throw new Error('boom');
      },
    });
    const token = sign('fix_stuck:ci_fix');
    expect(await runLandingAction(tapped(token), deps)).toMatchObject({ status: 'done', ok: false });
    const again = await runLandingAction(tapped(token), { ...deps, run: async () => ({ ok: true, summary: 'ok' }) });
    expect(again).toMatchObject({ status: 'done', ok: true });
  });
});

describe('runLandingAction: stale advice', () => {
  it('re-runs landing instead of acting when the head moved since the page', async () => {
    const { deps, calls } = fakeDeps({ readLiveHead: async () => 'head2' });
    const res = await runLandingAction(tapped(sign('fix_stuck:ci_fix')), deps);
    expect(res).toMatchObject({ status: 'done', ok: true, stale: true, liveHeadSha: 'head2' });
    expect(calls.map((c) => c.action)).toEqual(['retry_landing']);
    expect(calls[0]!.ctx.headSha).toBe('head2');
  });

  it('falls back to a landing re-run when the live head cannot be read', async () => {
    const { deps, calls } = fakeDeps({ readLiveHead: async () => null });
    const res = await runLandingAction(tapped(sign('fix_stuck:ci_fix')), deps);
    expect(res).toMatchObject({ status: 'done', stale: true });
    expect(calls.map((c) => c.action)).toEqual(['retry_landing']);
  });
});

describe('describeLandingAction: what the confirm screen shows', () => {
  it('lists the proposed action first and the options the reason offers', async () => {
    const { deps } = fakeDeps();
    const view = await describeLandingAction({ token: sign('needs_human:fix_exhausted'), ...ctxIn, prNumber: 42 }, deps);
    expect(view).toMatchObject({ state: 'ready', proposed: 'conflict', options: ['conflict', 'close_superseded'], reason: 'needs_human:fix_exhausted', headMoved: false });
  });

  it('flags a moved head', async () => {
    const { deps } = fakeDeps({ readLiveHead: async () => 'head9' });
    const view = await describeLandingAction({ token: sign('fix_stuck:ci_fix'), ...ctxIn, prNumber: 42 }, deps);
    expect(view).toMatchObject({ state: 'ready', headMoved: true });
  });

  it('shows the result of an already-confirmed link', async () => {
    const { deps } = fakeDeps();
    const token = sign('fix_stuck:ci_fix');
    await runLandingAction(tapped(token), deps);
    const view = await describeLandingAction({ token, ...ctxIn, prNumber: 42 }, deps);
    expect(view).toMatchObject({ state: 'already_done', result: { summary: 'ran ci_fix' } });
  });

  it('an expired or invalid link shows the fall-back state, never the action', async () => {
    const { deps } = fakeDeps({ now: () => NOW + LANDING_ACTION_TTL_MS + 1 });
    expect(await describeLandingAction({ token: sign('fix_stuck:ci_fix'), ...ctxIn, prNumber: 42 }, deps)).toMatchObject({ state: 'expired' });
    expect(await describeLandingAction({ token: 'junk', ...ctxIn, prNumber: 42 }, deps)).toMatchObject({ state: 'invalid' });
  });
});

describe('route reply mapping', () => {
  it('a dispatch route that filed a task is a success carrying the task', () => {
    expect(fromDispatchRoute('CI fix', { status: 200, json: { ok: true, dispatched: true, taskId: 't9' } })).toEqual({ ok: true, summary: 'CI fix dispatched.', taskId: 't9' });
  });
  it('a task already in flight is a success, not a duplicate', () => {
    expect(fromDispatchRoute('CI fix', { status: 200, json: { ok: true, dispatched: false, inFlight: true, taskId: 't9' } })).toMatchObject({ ok: true, summary: 'CI fix is already in progress.', taskId: 't9' });
  });
  it('a refusal surfaces the route message', () => {
    expect(fromDispatchRoute('CI fix', { status: 409, json: { error: 'PR is a draft' } })).toEqual({ ok: false, error: 'PR is a draft' });
  });
  it('merge: merged, branch updated and landing refusals are all the landing function answering', () => {
    expect(fromMergeRoute({ status: 200, json: { ok: true, merged: true } })).toMatchObject({ ok: true, outcome: 'merged' });
    expect(fromMergeRoute({ status: 202, json: { ok: false, merged: false, branchUpdated: true, message: 'updated' } })).toMatchObject({ ok: true, outcome: 'updating_branch' });
    expect(fromMergeRoute({ status: 409, json: { error: 'Merge refused: CI red', landing: { kind: 'needs_fix' } } })).toMatchObject({ ok: true, outcome: 'needs_fix', summary: 'Merge refused: CI red' });
    expect(fromMergeRoute({ status: 403, json: { error: 'Forbidden' } })).toEqual({ ok: false, error: 'Forbidden' });
  });
});
