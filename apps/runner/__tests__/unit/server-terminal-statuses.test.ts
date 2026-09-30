import { describe, it, expect } from 'bun:test';
import { SERVER_TERMINAL_STATUSES, SERVER_TERMINAL_TASK_STATUSES } from '../../src/worker-sync';
import { TERMINAL_WORKER_STATUSES, TERMINAL_TASK_STATUSES } from '@buildd/shared';

// The runner's view of "the server ended this" must be the server's own sets.
// A superseded worker (answered; work moved to a continuation task) used to be
// missed, so reconcile left its local session running.
describe('runner server-terminal sets', () => {
  it('cover every server-terminal worker status, superseded included', () => {
    for (const s of TERMINAL_WORKER_STATUSES) expect(SERVER_TERMINAL_STATUSES.has(s)).toBe(true);
    expect(SERVER_TERMINAL_STATUSES.has('superseded')).toBe(true);
    expect(SERVER_TERMINAL_STATUSES.has('paused')).toBe(false);
  });
  it('cover every terminal task status', () => {
    expect([...SERVER_TERMINAL_TASK_STATUSES].sort()).toEqual([...TERMINAL_TASK_STATUSES].sort());
  });
});
