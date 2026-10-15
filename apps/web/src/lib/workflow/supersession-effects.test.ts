/**
 * The kernel's `scan_supersession` effect (supersession-effects.ts): a scan whose record the
 * control plane did not take is a failed attempt, so the effect drain retries it with back-off,
 * never `ok` (incident 197552dc review).
 */
import { describe, expect, it, mock } from 'bun:test';

let detectAnswer: any = { outcome: 'none', candidatesChecked: 0 };
mock.module('@buildd/core/db', () => ({
  db: { query: { workers: { findFirst: async () => ({ id: 'w-1' }) } } },
}));
mock.module('@/lib/pr-supersession-detect', () => ({ detectPrSupersession: async () => detectAnswer }));

const { supersessionLifecycle } = await import('./supersession-effects');
const delivery = { id: 'd-1', workspaceId: 'ws-1', repoFullName: 'org/repo', prNumber: 7, state: 'CLOSED_UNMERGED' } as any;

describe('scan_supersession', () => {
  it('returns the scan outcome when it settled', async () => {
    detectAnswer = { outcome: 'suggested', suggestion: {}, candidatesChecked: 1 };
    expect(await supersessionLifecycle.scanSupersession!(delivery)).toBe('suggested');
  });

  it('throws on a deferred record, so the drain retries it instead of acking it', async () => {
    detectAnswer = { outcome: 'deferred', reason: 'the control plane did not answer', candidatesChecked: 1 };
    await expect(supersessionLifecycle.scanSupersession!(delivery)).rejects.toThrow('supersession record deferred');
  });
});
