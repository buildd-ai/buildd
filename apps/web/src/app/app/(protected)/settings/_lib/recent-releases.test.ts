import { describe, expect, it } from 'bun:test';
import { splitRecentReleases } from './recent-releases';

const row = (status: string | null, completedAt: string) => ({ status, completedAt, taskId: completedAt });

// Settings spec R-9 / AC-10: releases that ran are listed; skipped ones fold into one line.
describe('splitRecentReleases', () => {
  it('lists only releases that ran, at most five, and counts the skipped ones', () => {
    const rows = [
      row('skipped', '2026-10-12T10:00:00Z'),
      row('completed', '2026-10-12T09:00:00Z'),
      row('skipped', '2026-10-11T10:00:00Z'),
      row('failed', '2026-10-11T09:00:00Z'),
      row('completed', '2026-10-10T09:00:00Z'),
      row(null, '2026-10-09T09:00:00Z'),
      row('completed', '2026-10-08T09:00:00Z'),
      row('completed', '2026-10-07T09:00:00Z'),
      row('skipped', '2026-10-06T10:00:00Z'),
    ];
    const { ran, skipped, skippedSince } = splitRecentReleases(rows);
    expect(ran.map((r) => r.status)).toEqual(['completed', 'failed', 'completed', null, 'completed']);
    expect(skipped).toHaveLength(3);
    expect(skippedSince).toBe('2026-10-06T10:00:00Z');
  });

  it('has nothing to fold when no release was skipped', () => {
    const { skipped, skippedSince } = splitRecentReleases([row('completed', '2026-10-12T09:00:00Z')]);
    expect(skipped).toEqual([]);
    expect(skippedSince).toBeNull();
  });
});
