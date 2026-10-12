import { describe, it, expect, mock } from 'bun:test';

let row: Record<string, unknown> | undefined;
mock.module('@buildd/core/db', () => ({
  db: { query: { workers: { findFirst: async () => row } } },
}));

const { drizzleLocalSessionStore } = await import('./local-session');

describe('drizzleLocalSessionStore.workerState', () => {
  it('marks a live mcp-runner worker interactive', async () => {
    row = { taskId: 't1', pendingInstructions: null, status: 'running', runner: 'mcp' };
    expect(await drizzleLocalSessionStore.workerState('w1')).toEqual({
      taskId: 't1', pendingInstructions: false, live: true, interactive: true,
    });
  });

  it('marks a runner-managed worker not interactive', async () => {
    row = { taskId: 't1', pendingInstructions: null, status: 'running', runner: 'local' };
    const s = await drizzleLocalSessionStore.workerState('w1');
    expect(s?.interactive).toBe(false);
    expect(s?.live).toBe(true);
  });

  it('returns null for a missing worker', async () => {
    row = undefined;
    expect(await drizzleLocalSessionStore.workerState('w1')).toBeNull();
  });
});
