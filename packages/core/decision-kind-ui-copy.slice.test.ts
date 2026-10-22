import { describe, expect, it } from 'bun:test';
import { UI_COPY_CONFIG, uiCopyKind } from './decision-kind-ui-copy';
import { INFERENCE_CAPABILITIES } from './inference-policy';

describe('UI card clarity decision contract', () => {
  it('uses the production broker under its own opt-in capability and three narrow structured axes', () => {
    expect(uiCopyKind.kind).toBe('buildd.ui_copy');
    expect(uiCopyKind.binding).toMatchObject({ capability: 'ui_copy', mode: 'live' });
    expect(INFERENCE_CAPABILITIES.ui_copy.kind).toBe('opt_in');
    expect(Object.keys(UI_COPY_CONFIG.questions)).toEqual(['repetition', 'action_clarity', 'workflow_narration']);
    for (const q of Object.values(UI_COPY_CONFIG.questions)) expect(Object.keys(q.criteria)).toEqual(['clear', 'revise', 'uncertain']);
  });
  it('requires every axis to clear, preserves uncertainty and uses the lowest confidence for a pass', () => {
    const answer = (choice: 'clear' | 'revise' | 'uncertain', confidence = 0.97) => ({ type: 'choice' as const, choice, confidence, probabilities: { [choice]: confidence } });
    const answers = { repetition: answer('clear'), action_clarity: answer('clear'), workflow_narration: answer('clear', 0.6) };
    expect(UI_COPY_CONFIG.interpret(answers)).toMatchObject({ decision: 'concise', confidence: 0.6 });
    expect(UI_COPY_CONFIG.interpret({ ...answers, action_clarity: answer('uncertain') }).decision).toBe('insufficient_evidence');
    expect(UI_COPY_CONFIG.interpret({ ...answers, repetition: answer('revise') }).decision).toBe('needs_edit');
    expect(UI_COPY_CONFIG.fallback(null, 'disabled')).toMatchObject({ decision: 'insufficient_evidence' });
  });
  it('does not let an unrelated weak clear answer suppress a certain defect', () => {
    const answer = (choice: 'clear' | 'revise' | 'uncertain', confidence: number) => ({ type: 'choice' as const, choice, confidence, probabilities: { [choice]: confidence } });
    expect(UI_COPY_CONFIG.interpret({ repetition: answer('revise', 0.89), action_clarity: answer('clear', 0.38), workflow_narration: answer('clear', 0.43) }))
      .toMatchObject({ decision: 'needs_edit', confidence: 0.89, reasonCode: 'revise_repetition' });
    // One certain violation establishes failure even while another axis is unknown.
    expect(UI_COPY_CONFIG.interpret({ repetition: answer('uncertain', 0.2), action_clarity: answer('revise', 0.45), workflow_narration: answer('revise', 0.95) }))
      .toMatchObject({ decision: 'needs_edit', confidence: 0.95 });
    // Strong clear answers cannot turn a weak violation into a certain failure.
    expect(UI_COPY_CONFIG.interpret({ repetition: answer('revise', 0.35), action_clarity: answer('clear', 0.99), workflow_narration: answer('clear', 0.98) }))
      .toMatchObject({ decision: 'needs_edit', confidence: 0.35 });
    expect(UI_COPY_CONFIG.interpret({ repetition: answer('clear', 0.99), action_clarity: answer('uncertain', 0.4), workflow_narration: answer('clear', 0.98) }))
      .toMatchObject({ decision: 'insufficient_evidence', confidence: 0.4 });
  });
});
