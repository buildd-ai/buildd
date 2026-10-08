import { describe, expect, it } from 'bun:test';
import { extractMutableClaims, judgeBlockingVerdict, hasMutableClaims, MAX_SIBLING_PR_READS } from './escalation-revalidation';

const none = { prNumbers: [], migrationCollision: false, conflict: false };
const base = { liveHeadSha: 'b'.repeat(40), siblings: {}, migrationClear: true, conflictClear: true };

describe('extractMutableClaims', () => {
  it('reads the shapes reviewers actually write (replays #3502, #3571)', () => {
    expect(extractMutableClaims('Migration collides with open PR #3499 (0239_x.sql)', 3502)).toEqual({
      prNumbers: [3499], migrationCollision: true, conflict: false,
    });
    expect(extractMutableClaims('migration number collision: 0240_a.sql conflicts with open PR migration 0240_b.sql', 3571).migrationCollision).toBe(true);
    expect(extractMutableClaims('This PR has merge conflicts with the base', 1).conflict).toBe(true);
    expect(extractMutableClaims('see PR 3499 and #3500', 1).prNumbers).toEqual([3499, 3500]);
  });

  it('ignores the PR itself, URLs and anchors, and plain prose', () => {
    expect(extractMutableClaims('PR #42 reworks https://github.com/o/r/pull/77 and docs#section', 42).prNumbers).toEqual([]);
    expect(hasMutableClaims(extractMutableClaims('The handler reads secrets without an ownership check.', 1))).toBe(false);
  });
});

describe('judgeBlockingVerdict', () => {
  it('a verdict on a different head is stale (head_moved)', () => {
    const v = judgeBlockingVerdict({ ...base, reviewHeadSha: 'a'.repeat(40), claims: none });
    expect(v).toMatchObject({ stale: true, basis: 'head_moved' });
  });

  it('a head the verdict was carried to is the same diff, not a moved head', () => {
    const v = judgeBlockingVerdict({ ...base, reviewHeadSha: 'a'.repeat(40), equivalentHeadShas: ['b'.repeat(40)], claims: none });
    expect(v.stale).toBe(false);
  });

  it('same head, nothing mutable cited: the verdict stands', () => {
    expect(judgeBlockingVerdict({ ...base, reviewHeadSha: base.liveHeadSha, claims: none }).stale).toBe(false);
    expect(judgeBlockingVerdict({ ...base, reviewHeadSha: null, claims: none }).stale).toBe(false);
  });

  it('every cited sibling must be closed or merged, and readable', () => {
    const claims = { ...none, prNumbers: [1, 2] };
    expect(judgeBlockingVerdict({ ...base, reviewHeadSha: null, claims, siblings: { 1: 'merged', 2: 'closed' } })).toMatchObject({
      stale: true, basis: 'external_state', why: 'PR #1 is now merged; PR #2 is now closed',
    });
    expect(judgeBlockingVerdict({ ...base, reviewHeadSha: null, claims, siblings: { 1: 'merged', 2: 'open' } }).stale).toBe(false);
    expect(judgeBlockingVerdict({ ...base, reviewHeadSha: null, claims, siblings: { 1: 'merged' } }).stale).toBe(false);
  });

  it('too many cited PRs is not settled cheaply', () => {
    const prNumbers = Array.from({ length: MAX_SIBLING_PR_READS + 1 }, (_, i) => i + 1);
    const siblings = Object.fromEntries(prNumbers.map((n) => [n, 'merged' as const]));
    expect(judgeBlockingVerdict({ ...base, reviewHeadSha: null, claims: { ...none, prNumbers }, siblings }).stale).toBe(false);
  });

  it('a migration or conflict claim is stale only when the live rail passes', () => {
    expect(judgeBlockingVerdict({ ...base, reviewHeadSha: null, claims: { ...none, migrationCollision: true } }).stale).toBe(true);
    expect(judgeBlockingVerdict({ ...base, reviewHeadSha: null, migrationClear: false, claims: { ...none, migrationCollision: true } }).stale).toBe(false);
    expect(judgeBlockingVerdict({ ...base, reviewHeadSha: null, conflictClear: false, claims: { ...none, conflict: true } }).stale).toBe(false);
  });
});
