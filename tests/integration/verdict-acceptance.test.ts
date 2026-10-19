/**
 * Acceptance suite for criterion verdicts (AC-122 to AC-134), run in isolation:
 * pure folds over verdict rows, no server, no database, so it can run before any
 * builder task and fail on the contract alone.
 *
 * Groups: test-first precedence, reviewer override rejection, criterion
 * isolation, baseline satisfaction tracking.
 */
import { describe, expect, it } from 'bun:test';
import {
  determiningVerdict, foldGovernedOutcome, verdictSourceOf, verdictSourceOfEvidence,
  type CriterionVerdict, type VerdictSource,
} from '../../packages/spec-contract/src/outcome';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

const row = (
  source: VerdictSource, criterionId: string, verdict: CriterionVerdict['verdict'], at: number, headSha: string | null = HEAD,
): CriterionVerdict => ({ criterionId, verdict, headSha, at: new Date(at), source });
const test_ = (c: string, v: CriterionVerdict['verdict'], at: number, h: string | null = HEAD) => row('test', c, v, at, h);
const review = (c: string, v: CriterionVerdict['verdict'], at: number, h: string | null = HEAD) => row('review', c, v, at, h);

describe('test-first precedence', () => {
  it('AC-122 a check run is a test; every other author is a review', () => {
    expect(verdictSourceOf('check:t1')).toBe('test');
    for (const by of ['user:u', 'account:a', 'final-verification:t', 'visual:t', undefined, null, 7]) expect(verdictSourceOf(by)).toBe('review');
    expect(verdictSourceOfEvidence({ recordedBy: 'check:t1' })).toBe('test');
    expect(verdictSourceOfEvidence('junk')).toBe('review');
  });

  it('AC-123 a test result decides over an older review', () => {
    const d = determiningVerdict([review('R-1', 'pass', 1), test_('R-1', 'fail', 2)]);
    expect(d).toMatchObject({ source: 'test', verdict: 'fail' });
  });

  it('AC-124 a test result decides even when the review is newer', () => {
    const d = determiningVerdict([test_('R-1', 'pass', 1), review('R-1', 'fail', 2)]);
    expect(d).toMatchObject({ source: 'test', verdict: 'pass' });
  });

  it('AC-125 the newest test supersedes an earlier test', () => {
    const out = foldGovernedOutcome(['R-1'], [test_('R-1', 'fail', 1, OLD), test_('R-1', 'pass', 2)], HEAD);
    expect(out.outcome).toBe('verified');
    expect(out.criteria[0]).toMatchObject({ verdict: 'pass', source: 'test' });
  });

  it('AC-126 a test that settled nothing does not suppress a review', () => {
    for (const v of ['unsupported', 'inconclusive'] as const) {
      const d = determiningVerdict([test_('R-1', v, 1), review('R-1', 'pass', 2)]);
      expect(d).toMatchObject({ source: 'review', verdict: 'pass' });
    }
  });

  it('AC-127 with no test result the newest review stands', () => {
    const out = foldGovernedOutcome(['R-1'], [review('R-1', 'fail', 1), review('R-1', 'pass', 2)], HEAD);
    expect(out.criteria[0]).toMatchObject({ verdict: 'pass', source: 'review' });
    expect(out.outcome).toBe('verified');
  });
});

describe('reviewer override rejection', () => {
  it('AC-128 a later review pass cannot override a failed test', () => {
    const out = foldGovernedOutcome(['R-1'], [test_('R-1', 'fail', 1), review('R-1', 'pass', 2)], HEAD);
    expect(out.outcome).toBe('fail');
    expect(out.criteria[0]).toMatchObject({ verdict: 'fail', source: 'test', holds: false });
  });

  it('AC-129 a later review fail does not undo a passing test on the current head', () => {
    const out = foldGovernedOutcome(['R-1'], [test_('R-1', 'pass', 1), review('R-1', 'fail', 2)], HEAD);
    expect(out.outcome).toBe('verified');
    expect(out.criteria[0].holds).toBe(true);
  });

  it('AC-130 a review cannot rescue a test pass that judged an older head', () => {
    const out = foldGovernedOutcome(['R-1'], [test_('R-1', 'pass', 1, OLD), review('R-1', 'pass', 2)], HEAD);
    expect(out.outcome).toBe('unverified');
    expect(out.criteria[0]).toMatchObject({ source: 'test', stale: true, holds: false });
  });
});

describe('criterion isolation', () => {
  it('AC-131 a test on one criterion never decides another', () => {
    const out = foldGovernedOutcome(['R-1', 'R-2'], [test_('R-1', 'fail', 1), review('R-2', 'pass', 2)], HEAD);
    const by = Object.fromEntries(out.criteria.map((c) => [c.criterionId, c]));
    expect(by['R-1']).toMatchObject({ verdict: 'fail', source: 'test' });
    expect(by['R-2']).toMatchObject({ verdict: 'pass', source: 'review', holds: true });
  });

  it('AC-132 a failing criterion fails the outcome and is named, the passing one still holds', () => {
    const out = foldGovernedOutcome(['R-1', 'R-2'], [test_('R-1', 'pass', 1), test_('R-2', 'fail', 2)], HEAD);
    expect(out.outcome).toBe('fail');
    expect(out.reason).toContain('R-2');
    expect(out.reason).not.toContain('R-1');
    expect(out.criteria.find((c) => c.criterionId === 'R-1')?.holds).toBe(true);
  });
});

describe('baseline satisfaction tracking', () => {
  it('AC-133 a criterion with no verdict is unverified with no source', () => {
    const out = foldGovernedOutcome(['R-1'], [], HEAD);
    expect(out.outcome).toBe('unverified');
    expect(out.criteria[0]).toMatchObject({ verdict: null, source: null, stale: false, holds: false });
  });

  it('AC-134 an outcome is verified only when every criterion holds on the current head', () => {
    const ids = ['R-1', 'R-2'];
    expect(foldGovernedOutcome(ids, [test_('R-1', 'pass', 1)], HEAD).outcome).toBe('unverified');
    expect(foldGovernedOutcome(ids, [test_('R-1', 'pass', 1), review('R-2', 'pass', 2, OLD)], HEAD).outcome).toBe('unverified');
    expect(foldGovernedOutcome(ids, [test_('R-1', 'pass', 1), review('R-2', 'pass', 2)], HEAD).outcome).toBe('verified');
  });
});
