/**
 * Regression guard: 59% of failed workers had no error-level entry in their
 * OWN per-worker log — the terminal reason lived only in the worker state
 * JSON, and the two files shared no correlation key.
 *
 * Fix: hook `saveWorker()` itself (the single choke point ~25 call sites
 * across workers.ts/recovery.ts/hook-factory.ts/pusher-manager.ts/worker-sync.ts
 * already funnel through) rather than each `worker.error = ...` assignment
 * site — it fires exactly when the state file holding the reason is written.
 *
 * BUILDD_HOME is set before importing worker-store/session-logger (both read
 * it once into a module-level const), so this file uses one isolated temp
 * home for its whole process and distinct worker ids per test rather than
 * re-importing for a "fresh" home per test.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worker-store-terminal-error-log.test.ts
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'buildd-home-'));
process.env.BUILDD_HOME = home;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { saveWorker } = require('../../src/worker-store');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readSessionLogs } = require('../../src/session-logger');

afterAll(() => {
  delete process.env.BUILDD_HOME;
  rmSync(home, { recursive: true, force: true });
});

function baseWorker(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    taskId: 't-1',
    taskTitle: 'Test task',
    workspaceId: 'ws-1',
    workspaceName: 'test',
    branch: 'buildd/test',
    status: 'working',
    startedAt: Date.now(),
    lastActivity: Date.now(),
    messages: [],
    milestones: [],
    toolCalls: [],
    commits: [],
    output: [],
    ...overrides,
  } as any;
}

describe("saveWorker writes a terminal error into the worker's own session log", () => {
  test('a worker saved with status=error and an error message gets it recorded in its own log', () => {
    saveWorker(baseWorker('w-error-1', { status: 'error', error: 'Claude API 500: internal error' }));

    const entries = readSessionLogs('w-error-1');
    const terminal = entries.find((e: any) => e.level === 'error');
    expect(terminal).toBeTruthy();
    expect(terminal.detail).toContain('Claude API 500: internal error');
    expect(terminal.taskId).toBe('t-1');
  });

  test('a worker saved with status=working (no terminal error yet) writes nothing to its log', () => {
    saveWorker(baseWorker('w-working-1', { status: 'working' }));

    const entries = readSessionLogs('w-working-1');
    expect(entries.find((e: any) => e.level === 'error')).toBeUndefined();
  });

  test('saving the same terminal error twice does not duplicate the log entry', () => {
    const worker = baseWorker('w-error-2', { status: 'error', error: 'boom' });
    saveWorker(worker);
    saveWorker(worker); // e.g. a second unrelated field changes and re-saves

    const entries = readSessionLogs('w-error-2').filter((e: any) => e.level === 'error');
    expect(entries.length).toBe(1);
  });

  test('a worker that completes successfully after previously erroring does not re-trigger logging', () => {
    saveWorker(baseWorker('w-recovered-1', { status: 'error', error: 'transient' }));
    saveWorker(baseWorker('w-recovered-1', { status: 'done' }));

    const entries = readSessionLogs('w-recovered-1').filter((e: any) => e.level === 'error');
    expect(entries.length).toBe(1);
  });
});
