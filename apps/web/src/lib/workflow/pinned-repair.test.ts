/**
 * §13.13 rule 3 (workflow-kernel-library.md §5): a repair is a pinned,
 * executable builder. Its brief is the open findings, it names the PR head it
 * pushes to, and it never inherits a coordination owner's "no work" text.
 */
import { describe, expect, test } from 'bun:test';
import { isCoordinationOwner, pinnedFixDescription } from './review-effects';
import { noopEvidenceOf } from './seam';

const base = {
  prNumber: 7, round: 2, headRef: 'mission/kernel-abc', headSha: '0123456789abcdef', baseRef: 'dev',
  findings: [{ id: 'r1:0', path: 'src/a.ts', line: 3, title: 'rename the flag', status: 'addressed' }, { id: 'r1:1', path: null, line: null, title: 'add a test', status: 'open' }],
  feedback: 'Two things.',
};

describe('pinnedFixDescription', () => {
  test('the findings verbatim with their ids, the head to push to, and how completion is judged', () => {
    const d = pinnedFixDescription({ ...base, owner: { description: 'Build the thing.', kind: 'engineering' } });
    expect(d).toContain('- `r1:0` src/a.ts:3: rename the flag (a push touched its file; check it is really fixed)');
    expect(d).toContain('- `r1:1` add a test');
    expect(d).toContain("Push to the PR's own head branch `mission/kernel-abc`, currently at `0123456789ab` (base `dev`)");
    expect(d).toContain('A push that changes nothing near them is refused.');
    expect(d).toContain('structuredOutput.fixedElsewhere');
    expect(d).toContain('structuredOutput.noopEvidence');
    expect(d.indexOf('## Background: the original task')).toBeGreaterThan(d.indexOf('## When it is done'));
  });
  test('a coordination or bookkeeping owner\'s description is never copied', () => {
    for (const owner of [{ description: 'It performs no work of its own.', kind: 'coordination' }, { description: 'It performs no work of its own.', category: 'bookkeeping' }]) {
      const d = pinnedFixDescription({ ...base, owner });
      expect(d).not.toContain('performs no work');
      expect(isCoordinationOwner(owner)).toBe(true);
    }
    expect(isCoordinationOwner({ kind: 'engineering', category: 'feature' })).toBe(false);
  });
});

describe('noopEvidenceOf', () => {
  test('a claim needs finding ids and what was read', () => {
    expect(noopEvidenceOf({ noopEvidence: { findingIds: ['r1:0', ''], evidence: ' already absent ' } })).toEqual({ findingIds: ['r1:0'], evidence: 'already absent' });
    expect(noopEvidenceOf({ noopEvidence: { findingIds: [], evidence: 'x' } })).toBeNull();
    expect(noopEvidenceOf({ noopEvidence: { findingIds: ['r1:0'] } })).toBeNull();
    expect(noopEvidenceOf({ summary: 'done' })).toBeNull();
  });
});
