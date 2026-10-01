import { describe, it, expect, mock, beforeEach } from 'bun:test';

/**
 * The scheduling wrapper only: it runs after the response, never throws and
 * forwards decision receipts to ai_usage. The prediction itself is covered by
 * packages/core/__tests__/manifest-prediction*.test.ts.
 */
const calls: any[] = [];
let throwIt = false;
mock.module('@buildd/core/manifest-prediction-source', () => ({
  predictCreationManifest: async (input: any, deps: any) => {
    calls.push({ input, deps });
    if (throwIt) throw new Error('boom');
    return { skipped: 'capability_disabled' };
  },
}));

const { scheduleCreationManifestShadow, runCreationManifestShadow } = await import('./task-manifest-prediction');

const input = {
  taskId: '00000000-0000-4000-8000-000000000001',
  teamId: '00000000-0000-4000-8000-0000000000bb',
  workspaceId: '00000000-0000-4000-8000-0000000000aa',
  title: 'T',
  createdAt: new Date('2026-09-10T00:00:00Z'),
  callerManifest: ['**'],
};

beforeEach(() => { calls.length = 0; throwIt = false; });

describe('scheduleCreationManifestShadow', () => {
  it('hands the run to the scheduler (after the response) without running it inline', async () => {
    const scheduled: Array<() => Promise<unknown>> = [];
    scheduleCreationManifestShadow(input, fn => { scheduled.push(fn); });
    expect(scheduled).toHaveLength(1);
    expect(calls).toHaveLength(0);
    await scheduled[0]();
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual(input);
    expect(typeof calls[0].deps.onReceipt).toBe('function');
  });

  it('runs detached when no request scope exists, and never throws', async () => {
    expect(() => scheduleCreationManifestShadow(input, () => { throw new Error('no request scope'); })).not.toThrow();
    await new Promise(r => setTimeout(r, 0));
    expect(calls).toHaveLength(1);
  });

  it('a failing prediction is swallowed', async () => {
    throwIt = true;
    await expect(runCreationManifestShadow(input)).resolves.toBeUndefined();
  });
});
