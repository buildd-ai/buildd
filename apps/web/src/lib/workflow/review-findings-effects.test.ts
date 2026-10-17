/**
 * AC-35: buildd's verdict is a commit status GitHub can require. AC-37: the
 * follow-up for a merge over open findings is single-flight.
 */
import { describe, expect, test } from 'bun:test';
import { followupTaskId, verdictStatusFor } from './review-findings-effects';

const f = (o: Record<string, unknown> = {}) => ({ status: 'open', path: 'a.ts', line: 3, text: 'fix this', ...o });

describe('verdictStatusFor', () => {
  test('no findings ever: nothing to publish', () => expect(verdictStatusFor([])).toBeNull());
  test('open finding: failing status naming it', () => {
    const s = verdictStatusFor([f(), f({ status: 'resolved' })])!;
    expect(s.state).toBe('failure');
    expect(s.description).toContain('1 open finding');
    expect(s.description).toContain('a.ts:3');
  });
  test('turns success only when none is open', () => {
    expect(verdictStatusFor([f({ status: 'resolved' }), f({ status: 'waived' })])?.state).toBe('success');
  });
  test('description fits GitHub\'s 140 characters', () => {
    expect(verdictStatusFor([f({ text: 'x'.repeat(500) })])!.description.length).toBeLessThanOrEqual(140);
  });
});

test('the follow-up task id is stable per delivery and a valid uuid', () => {
  expect(followupTaskId('d1')).toBe(followupTaskId('d1'));
  expect(followupTaskId('d1')).not.toBe(followupTaskId('d2'));
  expect(followupTaskId('d1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
});
