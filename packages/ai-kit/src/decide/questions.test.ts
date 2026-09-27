import { describe, expect, it } from 'bun:test';
import {
  choice,
  gateChoice,
  MAX_CHOICE_OPTIONS,
  noul,
  parseDecisionAnswers,
  score,
  validateDecisionRequest,
  type ChoiceAnswer,
} from './index';

describe('question builders', () => {
  it('build the wire shapes the API expects', () => {
    expect(choice('Which team?', { payments: 'Checkout and billing', frontend: null })).toEqual({
      type: 'choice',
      instructions: 'Which team?',
      criteria: { payments: 'Checkout and billing', frontend: null },
    });
    expect(score('How urgent?', ['Can wait', 'This week', 'Now'])).toEqual({
      type: 'score',
      instructions: 'How urgent?',
      criteria: ['Can wait', 'This week', 'Now'],
    });
    expect(noul('Is this a bug?')).toEqual({ type: 'noul', instructions: 'Is this a bug?' });
    expect(noul('Is this a bug?', { true: 'A defect', false: 'Not one' }).criteria).toEqual({ true: 'A defect', false: 'Not one' });
  });

  it('keep the label union in the type', () => {
    const q = choice('Pick', { a: 'A', b: 'B' });
    const answer: ChoiceAnswer<keyof typeof q.criteria> = { type: 'choice', choice: 'a', probabilities: { a: 1, b: 0 }, confidence: 1 };
    // @ts-expect-error: 'c' is not a label
    const bad: ChoiceAnswer<keyof typeof q.criteria> = { ...answer, choice: 'c' };
    expect((bad as { choice: string }).choice).toBe('c');
  });

  it('copy score levels so a later mutation of the source does not change the question', () => {
    const levels = ['low', 'high'];
    const q = score('Level?', levels);
    levels.push('extra');
    expect(q.criteria).toEqual(['low', 'high']);
  });

  it('produce questions that validate', () => {
    expect(validateDecisionRequest('x', {
      c: choice('Pick', { a: 'A', b: 'B' }),
      s: score('Level', ['l', 'h']),
      n: noul('Yes?'),
    })).toBeNull();
  });
});

describe('validateDecisionRequest', () => {
  it('enforces label and level bounds', () => {
    const many = Object.fromEntries(Array.from({ length: MAX_CHOICE_OPTIONS + 1 }, (_, i) => [`l${i}`, null]));
    expect(validateDecisionRequest('x', { q: choice('i', many) })).toMatch(/max 255/);
    expect(validateDecisionRequest('x', { q: choice('i', { only: null }) })).toMatch(/at least 2/);
    expect(validateDecisionRequest('x', { q: score('i', ['one']) })).toMatch(/2-10/);
    expect(validateDecisionRequest('x', { q: score('i', Array.from({ length: 11 }, (_, i) => `l${i}`)) })).toMatch(/2-10/);
  });

  it('refuses empty state, no questions, no instructions and oversized state', () => {
    expect(validateDecisionRequest('  ', { q: noul('i') })).toMatch(/empty/);
    expect(validateDecisionRequest('x', {})).toMatch(/at least one/);
    expect(validateDecisionRequest('x', { q: noul('') })).toMatch(/no instructions/);
    expect(validateDecisionRequest('x'.repeat(200_000), { q: noul('i') })).toMatch(/exceeds/);
  });
});

describe('parseDecisionAnswers', () => {
  const questions = { team: choice('Which?', { a: 'A', b: 'B' }), bug: noul('Bug?') };
  const good = {
    team: { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 }, confidence: 0.9 },
    bug: { type: 'noul', noul: 0.2 },
  };

  it('accepts matching answers and drops extra ones', () => {
    const r = parseDecisionAnswers(questions, { ...good, extra: { type: 'noul', noul: 1 } });
    expect(r.ok && Object.keys(r.answers).sort()).toEqual(['bug', 'team']);
  });

  it('rejects a label outside the set, a missing answer, a type mismatch and an out-of-range noul', () => {
    expect(parseDecisionAnswers(questions, { ...good, team: { ...good.team, choice: 'z' } }).ok).toBe(false);
    expect(parseDecisionAnswers(questions, { team: good.team }).ok).toBe(false);
    expect(parseDecisionAnswers(questions, { ...good, bug: { type: 'choice', choice: 'a' } }).ok).toBe(false);
    expect(parseDecisionAnswers(questions, { ...good, bug: { type: 'noul', noul: 1.5 } }).ok).toBe(false);
  });
});

describe('gateChoice', () => {
  const answer = { type: 'choice' as const, choice: 'bug' as const, probabilities: { bug: 0.9 }, confidence: 0.85 };
  it('applies at or above the threshold and keeps the label below it', () => {
    expect(gateChoice(answer, 0.85)).toEqual({ apply: true, label: 'bug', confidence: 0.85 });
    expect(gateChoice(answer, 0.9)).toEqual({ apply: false, reason: 'low_confidence', label: 'bug', confidence: 0.85 });
    expect(gateChoice(null, 0.5)).toEqual({ apply: false, reason: 'no_answer' });
  });
});
