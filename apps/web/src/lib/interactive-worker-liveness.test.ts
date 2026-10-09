import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Friction 92866723: an interactive worker (claim_task from an MCP session,
 * runner = 'mcp') is alive while its session keeps calling buildd. The touch is
 * the write that records that; what it may touch is only visible in the SQL, so
 * the WHERE is rendered rather than trusted to a mocked predicate.
 */

let updateCalls: Array<{ set: any; where: any }> = [];
let updateThrows = false;

mock.module('@buildd/core/db', () => ({
  db: {
    update: () => {
      if (updateThrows) throw new Error('db down');
      const call = { set: undefined as any, where: undefined as any };
      updateCalls.push(call);
      return {
        set: (v: any) => {
          call.set = v;
          return { where: async (w: any) => { call.where = w; } };
        },
      };
    },
  },
}));

import { INTERACTIVE_WORKER_RUNNER } from '@buildd/shared';
import { INTERACTIVE_RUNNER, UNVERIFIED_INTERACTIVE_RUNNER } from './interactive-session';
import {
  INTERACTIVE_CLAIM_SESSION_KEY,
  INTERACTIVE_CLAIM_USER_KEY,
  INTERACTIVE_TOUCH_THROTTLE_MS,
  isInitializeOnlyRequest,
  isInteractiveWorker,
  resetInteractiveTouchMemo,
  runnerWorkerOnly,
  scheduleInteractiveTouch,
  touchInteractiveWorkers,
} from './interactive-worker-liveness';

const dialect = new PgDialect();
const NOW = new Date('2026-09-28T12:00:00.000Z');
const render = () => dialect.sqlToQuery(updateCalls[0].where);

beforeEach(() => {
  updateCalls = [];
  updateThrows = false;
  resetInteractiveTouchMemo();
});

describe('touchInteractiveWorkers', () => {
  it('a token with no session user covers the account\'s own live interactive workers', async () => {
    await touchInteractiveWorkers({ accountId: 'account-1', now: NOW });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].set).toEqual({ updatedAt: NOW });
    const q = render();
    expect(q.sql).toMatch(/"workers"\."account_id" = \$\d/);
    expect(q.sql).toMatch(/"workers"\."runner" = \$\d/);
    expect(q.params).toEqual(expect.arrayContaining(['account-1', 'mcp']));
    expect(q.sql).not.toContain(INTERACTIVE_CLAIM_USER_KEY);
    // Terminal rows are never revived, and a parked question keeps its own clock.
    expect(q.params).not.toContain('completed');
    expect(q.params).not.toContain('failed');
    expect(q.params).not.toContain('waiting_input');
  });

  // Review of #3052: OAuth sessions share the team's account, so another
  // member's session must not keep my claims alive.
  it('a session with a user only touches the workers that user claimed', async () => {
    await touchInteractiveWorkers({ accountId: 'account-1', userId: 'user-a', now: NOW });
    const q = render();
    expect(q.sql).toContain('t_claim.id = "workers"."task_id"');
    expect(q.sql).toMatch(/t_claim\.context->>\$\d+ = \$\d+/);
    expect(q.params).toEqual(expect.arrayContaining([INTERACTIVE_CLAIM_USER_KEY, 'user-a']));
    expect(q.params).not.toContain('user-b');
  });

  // Review of #3072: a bld_ key has no session user, so one live session kept
  // every other session's interactive claims on the account alive.
  it('a session with a key only touches the workers that session claimed', async () => {
    await touchInteractiveWorkers({ accountId: 'account-1', sessionKey: 'sess-a', now: NOW });
    const q = render();
    expect(q.sql).toContain('t_sess.id = "workers"."task_id"');
    expect(q.sql).toMatch(/t_sess\.context->>\$\d+ = \$\d+/);
    expect(q.sql).not.toContain('NOT EXISTS');
    expect(q.params).toEqual(expect.arrayContaining([INTERACTIVE_CLAIM_SESSION_KEY, 'sess-a']));
    expect(q.params).not.toContain('sess-b');
  });

  it("a session with no key never touches a keyed session's claims", async () => {
    await touchInteractiveWorkers({ accountId: 'account-1', now: NOW });
    const q = render();
    const text = q.sql.replace(/\s+/g, ' ');
    expect(text).toContain('NOT EXISTS ( SELECT 1 FROM "tasks" t_sess WHERE t_sess.id = "workers"."task_id"');
    expect(text).toMatch(/t_sess\.context->>\$\d+ IS NOT NULL/);
    expect(q.params).toContain(INTERACTIVE_CLAIM_SESSION_KEY);
  });

  it('memoises per session key', async () => {
    await touchInteractiveWorkers({ accountId: 'account-1', sessionKey: 'sess-a', now: NOW });
    await touchInteractiveWorkers({ accountId: 'account-1', sessionKey: 'sess-b', now: new Date(NOW.getTime() + 1000) });
    await touchInteractiveWorkers({ accountId: 'account-1', sessionKey: 'sess-a', now: new Date(NOW.getTime() + 2000) });
    expect(updateCalls).toHaveLength(2);
  });

  it('memoises per (account, user) for the throttle window', async () => {
    await touchInteractiveWorkers({ accountId: 'account-1', userId: 'user-a', now: NOW });
    await touchInteractiveWorkers({ accountId: 'account-1', userId: 'user-a', now: new Date(NOW.getTime() + 1000) });
    expect(updateCalls).toHaveLength(1);
    // A different member is a different key.
    await touchInteractiveWorkers({ accountId: 'account-1', userId: 'user-b', now: new Date(NOW.getTime() + 1000) });
    expect(updateCalls).toHaveLength(2);
    // After the window it writes again.
    await touchInteractiveWorkers({ accountId: 'account-1', userId: 'user-a', now: new Date(NOW.getTime() + INTERACTIVE_TOUCH_THROTTLE_MS + 1) });
    expect(updateCalls).toHaveLength(3);
  });

  it('does nothing without an account', async () => {
    await touchInteractiveWorkers({ accountId: undefined, now: NOW });
    await touchInteractiveWorkers({ accountId: null, now: NOW });
    expect(updateCalls).toHaveLength(0);
  });

  it('never throws: a failed touch must not fail the MCP call it rides on', async () => {
    updateThrows = true;
    await expect(touchInteractiveWorkers({ accountId: 'account-1', now: NOW })).resolves.toBeUndefined();
  });
});

describe('scheduleInteractiveTouch', () => {
  it('touches for worker- and admin-level sessions', async () => {
    scheduleInteractiveTouch({ accountId: 'account-1', level: 'worker' });
    scheduleInteractiveTouch({ accountId: 'account-2', level: 'admin' });
    await new Promise(r => setTimeout(r, 0));
    expect(updateCalls).toHaveLength(2);
  });

  it('a trigger-level (or unknown) token never keeps claims alive', async () => {
    scheduleInteractiveTouch({ accountId: 'account-1', level: 'trigger' });
    scheduleInteractiveTouch({ accountId: 'account-1', level: 'viewer' });
    scheduleInteractiveTouch({ accountId: 'account-1', level: undefined });
    await new Promise(r => setTimeout(r, 0));
    expect(updateCalls).toHaveLength(0);
  });
});

describe('initialize requests never touch', () => {
  const rpc = (b: unknown) => new Request('http://x/api/mcp', { method: 'POST', body: JSON.stringify(b) });

  it('an initializeOnly request is not a touch', async () => {
    scheduleInteractiveTouch({ accountId: 'account-1', level: 'worker', initializeOnly: true });
    await new Promise(r => setTimeout(r, 0));
    expect(updateCalls).toHaveLength(0);
  });

  it('detects initialize, leaves the body readable, and rejects other calls', async () => {
    const init = rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(await isInitializeOnlyRequest(init)).toBe(true);
    expect(await init.json()).toMatchObject({ method: 'initialize' });
    expect(await isInitializeOnlyRequest(rpc({ method: 'tools/call' }))).toBe(false);
    expect(await isInitializeOnlyRequest(rpc([{ method: 'initialize' }, { method: 'tools/list' }]))).toBe(false);
    expect(await isInitializeOnlyRequest(new Request('http://x', { method: 'POST', body: 'nope' }))).toBe(false);
  });
});

describe('isInteractiveWorker / runnerWorkerOnly', () => {
  it('exact match on the mcp runner id; an unverified mcp claim is a runner', () => {
    expect(isInteractiveWorker('mcp')).toBe(true);
    expect(isInteractiveWorker(UNVERIFIED_INTERACTIVE_RUNNER)).toBe(false);
    expect(isInteractiveWorker('mcp-runner-7')).toBe(false);
    expect(isInteractiveWorker(null)).toBe(false);
  });

  it('the reaper and the claim route agree on the interactive runner id', () => {
    expect(INTERACTIVE_WORKER_RUNNER).toBe(INTERACTIVE_RUNNER);
  });

  it('runnerWorkerOnly renders runner <> mcp', () => {
    const q = dialect.sqlToQuery(runnerWorkerOnly());
    expect(q.sql).toMatch(/"workers"\."runner" <> \$1/);
    expect(q.params).toEqual(['mcp']);
  });
});
