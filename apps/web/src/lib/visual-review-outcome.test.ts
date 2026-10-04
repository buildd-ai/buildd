import { describe, expect, it } from 'bun:test';
import { decisionOutcome, type DecisionOutcomeInput } from './visual-review-outcome';

const base: DecisionOutcomeInput = {
  decision: 'needs_fix',
  shots: [{ agentVerdict: 'issue', check: false, linkedOpen: false }],
  filed: false,
  reused: false,
  cancelled: false,
  annotated: [],
  roundCapOpen: false,
};
const out = (over: Partial<DecisionOutcomeInput>) => decisionOutcome({ ...base, ...over });

describe('decisionOutcome: one outcome per server branch (design doc, "The deck queue")', () => {
  it('needs fix', () => {
    expect(out({ filed: true })).toBe('fix_filed');
    expect(out({ reused: true })).toBe('fix_added');
    expect(out({ annotated: ['note'] })).toBe('fix_noted');
    expect(out({ shots: [{ agentVerdict: 'issue', check: false, linkedOpen: true }] })).toBe('fix_kept');
    expect(out({ shots: [{ agentVerdict: 'issue', check: false, linkedOpen: true }], roundCapOpen: true })).toBe('fix_kept_no_recheck');
    expect(out({})).toBe('fix_done');
    // Still broken on a fix check files a new fix.
    expect(out({ shots: [{ agentVerdict: 'ok', check: true, linkedOpen: false }], filed: true })).toBe('fix_filed');
  });

  it('looks right', () => {
    const lr = (over: Partial<DecisionOutcomeInput>) => out({ decision: 'looks_right', ...over });
    expect(lr({ cancelled: true })).toBe('fix_cancelled');
    expect(lr({ annotated: ['started'] })).toBe('fix_started');
    expect(lr({ annotated: ['still_linked'] })).toBe('fix_still_linked');
    expect(lr({ shots: [{ agentVerdict: 'ok', check: true, linkedOpen: false }] })).toBe('marked_fixed');
    expect(lr({})).toBe('not_a_bug');
    expect(lr({ shots: [{ agentVerdict: 'unsure', check: false, linkedOpen: false }] })).toBe('marked_fine');
    expect(lr({ shots: [{ agentVerdict: 'ok', check: false, linkedOpen: false }] })).toBe('marked_fine');
  });

  it('a request with more than one effect reports the first in table order', () => {
    expect(out({ filed: true, reused: true, annotated: ['note'] })).toBe('fix_filed');
    expect(out({ decision: 'looks_right', cancelled: true, annotated: ['started'] })).toBe('fix_cancelled');
  });
});
