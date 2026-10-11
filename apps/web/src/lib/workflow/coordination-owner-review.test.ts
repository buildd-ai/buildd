/**
 * edc02148 (#4413): a coordination owner stays assigned after it opens its PR, so the
 * owner hand-off (§6.5 row 1) that queues a review can be hours away. The PR is
 * reviewed when it opens (T5 from WORKING) instead.
 */
import { describe, expect, test } from 'bun:test';
import type { LivePr } from './commands';
import { reviewOwedWhileOwnerRuns } from './seam';

const live = (o: Partial<LivePr> = {}): LivePr => ({ state: 'open', merged: false, headSha: 'H1', headRepoFullName: 'acme/widgets', baseRef: 'dev', ...o });

describe('reviewOwedWhileOwnerRuns', () => {
  test('a coordination owner\'s open, ready PR is reviewed now', () => {
    expect(reviewOwedWhileOwnerRuns({ kind: 'coordination' }, live())).toBe(true);
  });
  test('any other owner waits for its hand-off, as before', () => {
    for (const kind of ['engineering', 'research', 'writing', null, undefined]) expect(reviewOwedWhileOwnerRuns({ kind }, live())).toBe(false);
  });
  test('a draft, closed, merged or unread PR is not reviewed', () => {
    expect(reviewOwedWhileOwnerRuns({ kind: 'coordination' }, live({ draft: true }))).toBe(false);
    expect(reviewOwedWhileOwnerRuns({ kind: 'coordination' }, live({ state: 'closed' }))).toBe(false);
    expect(reviewOwedWhileOwnerRuns({ kind: 'coordination' }, live({ state: 'closed', merged: true }))).toBe(false);
    expect(reviewOwedWhileOwnerRuns({ kind: 'coordination' }, null)).toBe(false);
  });
});
