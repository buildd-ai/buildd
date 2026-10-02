// Stalled full ingest jobs never become failed workers, so get_failure_analytics
// could not see them: the only report was the runner claim response.
import { describe, expect, it } from 'bun:test';
import { summarizeStalledIngest, STALLED_INGEST_LIST_LIMIT, type StallRowInput } from './knowledge-ingest-stalls';
import { FALLBACK_LEASE_OWNER } from './knowledge-full-ingest-fallback';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-10-02T12:00:00Z');

function row(over: Partial<StallRowInput> = {}): StallRowInput {
  return {
    id: 'job-1',
    workspaceId: 'ws-1',
    repo: 'test-org/test-repo',
    scope: 'full',
    status: 'queued',
    attempts: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    startedAt: null,
    createdAt: new Date(NOW.getTime() - 5 * HOUR),
    stats: null,
    ...over,
  };
}

describe('summarizeStalledIngest', () => {
  it('returns null when nothing is stuck', () => {
    const fresh = row({ createdAt: new Date(NOW.getTime() - 10 * 60 * 1000) });
    const runnerOwned = row({
      id: 'job-2',
      status: 'running',
      leaseOwner: 'runner-a',
      leaseExpiresAt: new Date(NOW.getTime() + HOUR),
    });
    expect(summarizeStalledIngest([fresh, runnerOwned], NOW)).toBeNull();
  });

  it('reports stalled and fallback jobs, oldest first, with the runner reason and progress', () => {
    const report = summarizeStalledIngest(
      [
        row({ id: 'stalled', stats: { checkoutReport: { reason: 'git fetch origin failed: Permission denied' } } }),
        row({
          id: 'rescued',
          status: 'running',
          leaseOwner: FALLBACK_LEASE_OWNER,
          leaseExpiresAt: new Date(NOW.getTime() + 2 * HOUR),
          createdAt: new Date(NOW.getTime() - 30 * 24 * HOUR),
          stats: { fallback: { sha: 's', cursor: 120, total: 400, startedAt: NOW.toISOString(), lastError: 'GitHub API error: 502' } },
        }),
        row({ id: 'diff-ignored', scope: 'diff' }),
      ],
      NOW,
    )!;
    expect(report.stalled).toBe(1);
    expect(report.inFallback).toBe(1);
    expect(report.oldestAgeMs).toBe(30 * 24 * HOUR);
    expect(report.jobs.map(j => j.id)).toEqual(['rescued', 'stalled']);
    expect(report.jobs[0]).toMatchObject({ state: 'fallback', progress: { cursor: 120, total: 400 }, lastError: expect.stringContaining('502') });
    expect(report.jobs[1]).toMatchObject({ state: 'stalled', checkoutReason: expect.stringContaining('Permission denied') });
  });

  it('caps the listed jobs but counts every one', () => {
    const rows = Array.from({ length: STALLED_INGEST_LIST_LIMIT + 3 }, (_, i) => row({ id: `j${i}` }));
    const report = summarizeStalledIngest(rows, NOW)!;
    expect(report.stalled).toBe(STALLED_INGEST_LIST_LIMIT + 3);
    expect(report.jobs.length).toBe(STALLED_INGEST_LIST_LIMIT);
  });
});
