/**
 * Pure durable-finding rules (docs/specs/workflow-state-kernel.md §13.13 rule 2).
 * AC-24 / AC-25: findings survive everything but an explicit resolution or a waiver.
 */
import { describe, expect, test } from 'bun:test';
import { findingFingerprint, findingsFromReview, resolveFindings, waiverClosure, describeFinding, openFindings } from './findings';
import type { FindingSnapshot } from './types';

const F = (o: Partial<FindingSnapshot> = {}): FindingSnapshot => ({
  id: 'f1', roundId: 'r1', round: 1, reviewedHeadSha: 'H1', path: 'a.ts', line: 3, text: 'fix copy', fingerprint: 'fp1', status: 'open', ...o,
});
const R = { deltaPaths: null, headSha: 'H2', round: 2, roundId: 'r2' };

describe('findingsFromReview', () => {
  test('one row per distinct named issue, deduped', () => {
    const out = findingsFromReview({ findings: [{ path: 'a.ts', line: 3, text: 'x' }, { file: 'a.ts', line: 3, message: 'x' }, { path: 'b.ts', text: 'y' }] });
    expect(out).toEqual([{ path: 'a.ts', line: 3, text: 'x' }, { path: 'b.ts', line: null, text: 'y' }]);
  });
  test('prose only becomes ONE round-scoped finding, never nothing', () => {
    expect(findingsFromReview({ feedback: 'two copy problems' })).toEqual([{ path: null, line: null, text: 'two copy problems' }]);
    expect(findingsFromReview({})).toHaveLength(1);
  });
  test('fingerprint is stable under whitespace', () => {
    expect(findingFingerprint({ path: 'a', line: 1, text: 'a  b' })).toBe(findingFingerprint({ path: 'a', line: 1, text: ' a b ' }));
  });
});

describe('resolveFindings', () => {
  test('AC-25: closes only a named finding whose path changed', () => {
    const r = resolveFindings([F(), F({ id: 'f2', path: 'b.ts' })], R, ['f1', 'f2'], ['a.ts']);
    expect(r.resolved.map((f) => f.id)).toEqual(['f1']);
    expect(r.refused).toEqual([{ id: 'f2', reason: 'path_unchanged' }]);
    expect(r.stillOpen.map((f) => f.id)).toEqual(['f2']);
  });
  test('AC-24: an approve that names nothing closes nothing', () => {
    expect(resolveFindings([F()], R, undefined, ['a.ts']).stillOpen).toHaveLength(1);
  });
  test('AC-24: a delta round scoped away from the path cannot close it', () => {
    const r = resolveFindings([F()], { ...R, deltaPaths: ['other.ts'] }, ['f1'], ['a.ts']);
    expect(r.refused).toEqual([{ id: 'f1', reason: 'outside_round_scope' }]);
  });
  test('a round-scoped finding needs only the naming, a delta round cannot close it', () => {
    expect(resolveFindings([F({ path: null })], R, ['f1'], []).resolved).toHaveLength(1);
    expect(resolveFindings([F({ path: null })], { ...R, deltaPaths: ['x'] }, ['f1'], []).resolved).toHaveLength(0);
  });
  test('unknown and already-closed ids are refused', () => {
    const r = resolveFindings([F({ status: 'waived' })], R, ['f1', 'nope'], ['a.ts']);
    expect(r.refused).toEqual([{ id: 'f1', reason: 'not_open' }, { id: 'nope', reason: 'unknown' }]);
  });
});

describe('waiverClosure', () => {
  test('AC-25: needs a person and a reason', () => {
    expect(waiverClosure([F()], { actor: 'agent:t', reason: 'ok', scope: 'all' })).toEqual({ ok: false, reason: 'waiver_requires_human' });
    expect(waiverClosure([F()], { actor: 'human:u', reason: ' ', scope: 'all' })).toEqual({ ok: false, reason: 'waiver_requires_reason' });
    expect(waiverClosure([], { actor: 'human:u', reason: 'x', scope: 'all' })).toEqual({ ok: false, reason: 'nothing_to_waive' });
  });
  test('scope limits what closes', () => {
    const w = waiverClosure([F(), F({ id: 'f2' })], { actor: 'human:u', reason: 'x', scope: ['f2'] });
    expect(w.ok && w.closes.map((f) => f.id)).toEqual(['f2']);
  });
});

test('openFindings and describeFinding', () => {
  expect(openFindings([F(), F({ id: 'f2', status: 'resolved' })])).toHaveLength(1);
  expect(describeFinding(F())).toBe('a.ts:3: fix copy');
  expect(describeFinding(F({ path: null }))).toBe('whole PR: fix copy');
});
