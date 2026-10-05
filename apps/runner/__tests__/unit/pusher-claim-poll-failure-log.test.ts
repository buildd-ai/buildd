/**
 * Regression guard: a claim-poll failure on Pusher reconnect/startup used to
 * be logged via `console.error('...', err)` — passing the raw Error object
 * prints its full stack trace (~13 Bun source-frame lines per occurrence),
 * measured at 6.6% of the entire runner log. 97% of those occurrences are
 * the benign no_pending_tasks nudge/poll race, whose clean reason is already
 * logged elsewhere (claimPendingTasks's own claimLog call) — so this call
 * site should log a single line with just the message, collapsed under a
 * repeat burst (e.g. a flapping reconnect), never the raw Error/stack.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/pusher-claim-poll-failure-log.test.ts
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { PusherManager } from '../../src/pusher-manager';
import { __resetCollapseState } from '../../src/log';

function captureConsole() {
  const lines: { method: string; args: unknown[] }[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args: unknown[]) => lines.push({ method: 'log', args });
  console.warn = (...args: unknown[]) => lines.push({ method: 'warn', args });
  console.error = (...args: unknown[]) => lines.push({ method: 'error', args });
  return {
    lines,
    restore: () => {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    },
  };
}

function makeManager(claimPendingTasks: () => Promise<any[]>, claimAndStart: (task: any) => Promise<any> = async () => null) {
  const callbacks: any = {
    getWorkers: () => new Map(),
    emit: () => {},
    emitCommand: () => {},
    abort: async () => {},
    sendMessage: async () => {},
    rollback: async () => ({}),
    recover: async () => {},
    sendHeartbeat: () => {},
    claimPendingTasks,
    claimAndStart,
    getProbedWorkers: () => new Set<string>(),
  };
  const config: any = {
    pusherKey: undefined,
    pusherCluster: undefined,
    pusherChannelPrefix: '',
    acceptRemoteTasks: true,
    maxConcurrent: 2,
  };
  return new PusherManager(config, {} as any, callbacks);
}

describe('claim-poll failure logging', () => {
  beforeEach(() => __resetCollapseState());

  test('logs a single-line message, never the raw Error object (no stack dump)', async () => {
    const err = new Error('boom: server unreachable');
    const manager = makeManager(async () => { throw err; });
    const cap = captureConsole();
    try {
      await (manager as any).pollPendingTasksBestEffort('reconnect');
    } finally {
      cap.restore();
    }

    expect(cap.lines.length).toBe(1);
    const [arg] = cap.lines[0].args;
    // Must be a plain string, not the Error object itself (console.error on an
    // Error prints its stack — exactly the multi-line dump being eliminated).
    expect(typeof arg).toBe('string');
    expect(String(arg)).toContain('boom: server unreachable');
    expect(String(arg).split('\n').length).toBe(1);
  });

  test('a rapid repeat burst collapses to one direct line instead of one per occurrence', async () => {
    const manager = makeManager(async () => { throw new Error('flapping'); });
    const cap = captureConsole();
    try {
      for (let i = 0; i < 50; i++) {
        await (manager as any).pollPendingTasksBestEffort('reconnect');
      }
    } finally {
      cap.restore();
    }
    // All 50 calls happen effectively at the same instant (well within any
    // reasonable collapse window), so only the first should print directly.
    expect(cap.lines.length).toBe(1);
  });

  test('a successful claim poll logs nothing', async () => {
    const manager = makeManager(async () => []);
    const cap = captureConsole();
    try {
      await (manager as any).pollPendingTasksBestEffort('startup');
    } finally {
      cap.restore();
    }
    expect(cap.lines.length).toBe(0);
  });
});

// A Pusher assignment that loses the claim race (another runner, or the poll,
// got there first) is the normal outcome of a broadcast, not a failure. It was
// logged via console.error with the raw Error — a full stack per lost race.
describe('task-assignment claim failure logging', () => {
  const task = { id: 'task-1', title: 'T', workspaceId: 'ws-1' };

  function lostRace() {
    return Object.assign(
      new Error('Server rejected claim for task "T" — task is no longer available (may already be claimed or completed)'),
      { claimError: 'server_rejected', claimReason: 'no_pending_tasks' },
    );
  }

  test('a lost claim race logs one info line, no Error object, no stack', async () => {
    const manager = makeManager(async () => [], async () => { throw lostRace(); });
    const cap = captureConsole();
    try {
      await manager.handleTaskAssignment({ task: task as any });
    } finally {
      cap.restore();
    }
    expect(cap.lines.filter(l => l.method === 'error')).toHaveLength(0);
    const race = cap.lines.filter(l => String(l.args[0]).includes('task-1') && /claim race/i.test(String(l.args[0])));
    expect(race).toHaveLength(1);
    expect(race[0].method).toBe('log');
    expect(race[0].args.every(a => typeof a === 'string')).toBe(true);
    expect(String(race[0].args[0]).split('\n')).toHaveLength(1);
  });

  test('a server rejection for any other reason is still an error', async () => {
    const err = Object.assign(new Error('Server rejected claim for task "T" — reason: no_slots'), {
      claimError: 'server_rejected', claimReason: 'no_slots',
    });
    const manager = makeManager(async () => [], async () => { throw err; });
    const cap = captureConsole();
    try {
      await manager.handleTaskAssignment({ task: task as any });
    } finally {
      cap.restore();
    }
    expect(cap.lines.filter(l => l.method === 'error')).toHaveLength(1);
  });

  test('a genuine claim error stays at error level', async () => {
    const manager = makeManager(async () => [], async () => { throw new Error('API error: 500 - boom'); });
    const cap = captureConsole();
    try {
      await manager.handleTaskAssignment({ task: task as any });
    } finally {
      cap.restore();
    }
    const errors = cap.lines.filter(l => l.method === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].args.some(a => String(a).includes('API error: 500'))).toBe(true);
  });
});
