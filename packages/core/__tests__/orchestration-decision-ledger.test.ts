import { expect, it } from 'bun:test';
import { isOrchestrationCapability, summarizeOrchestrationDecisions } from '../orchestration-decision-ledger';

it('detects orchestration capabilities', () => {
  expect(isOrchestrationCapability('orchestration_claim')).toBe(true);
  expect(isOrchestrationCapability('question_gate')).toBe(false);
  expect(isOrchestrationCapability(null)).toBe(false);
});

it('tells an applied START from an applied HOLD', () => {
  const row = (appliedAnswer: string | null, verdict: string) => ({ appliedAnswer, verdict, status: 'applied', reason: null, confidence: 0.9 }) as any;
  const s = summarizeOrchestrationDecisions([row('START', 'START'), row('HOLD', 'HOLD'), row('HOLD', 'START'), row(null, 'START')]);
  expect(s.byAppliedAnswer).toEqual({ START: 1, HOLD: 2, none: 1 });
  expect(s.byVerdict).toEqual({ START: 3, HOLD: 1 });
});
