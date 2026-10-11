import { describe, expect, test } from 'bun:test';
import {
  classifyRecoverableBlocker,
  fallbackQuestionContext,
  isContextFree,
  recoveredAnswerText,
  repairTaskSpec,
} from '../human-attention';

// The question that reached a person as a bare "How should I proceed?" card.
const MIGRATION_QUESTION =
  'Visual QA cannot boot the app: the mission migration is below the migration high-water mark, so db:migrate refuses it. ' +
  'I tried re-running the capture twice. How should I proceed?';

describe('classifyRecoverableBlocker', () => {
  test('migration ordering below the high-water mark is a recoverable blocker', () => {
    const b = classifyRecoverableBlocker(MIGRATION_QUESTION);
    expect(b?.kind).toBe('migration_order');
  });

  test.each([
    ['merge_conflict', 'The branch has a merge conflict with dev in two files. Should I continue?'],
    ['ci_failure', 'CI is failing on dev too, unrelated to this change. What should I do?'],
    ['missing_generated', 'The drizzle snapshot is missing for the last migration. Proceed?'],
    ['platform_retryable', 'The GitHub API returned HTTP 503 three times. Should I keep going?'],
  ])('%s', (kind, text) => {
    expect(classifyRecoverableBlocker(text)?.kind).toBe(kind as never);
  });

  test('a real product decision is not a blocker', () => {
    expect(classifyRecoverableBlocker('Adding isWeekend() to billing. Should it use local time or UTC?')).toBeNull();
  });

  test('a CI failure the agent caused is not routed away from it', () => {
    expect(classifyRecoverableBlocker('My change made the type check fail. Revert or fix forward?')).toBeNull();
  });

  test('the signature is stable per kind and scope, so repeats dedupe', () => {
    const a = classifyRecoverableBlocker(MIGRATION_QUESTION)!;
    const b = classifyRecoverableBlocker('This migration is below the high-water mark. Now what?')!;
    expect(repairTaskSpec(a, { scopeId: 'm1' }).signature).toBe(repairTaskSpec(b, { scopeId: 'm1' }).signature);
    expect(repairTaskSpec(a, { scopeId: 'm1' }).signature).not.toBe(repairTaskSpec(a, { scopeId: 'm2' }).signature);
  });
});

describe('repairTaskSpec / recoveredAnswerText', () => {
  test('the repair task carries what failed and which task is waiting', () => {
    const b = classifyRecoverableBlocker(MIGRATION_QUESTION)!;
    const spec = repairTaskSpec(b, { scopeId: 'm1', blockedTaskId: 't1', blockedTaskTitle: 'Surface audit', evidence: MIGRATION_QUESTION });
    expect(spec.title.length).toBeLessThanOrEqual(120);
    expect(spec.description).toContain('Surface audit');
    expect(spec.description).toContain('high-water mark');
  });

  test('the agent is told a repair exists and not to wait on a person', () => {
    const b = classifyRecoverableBlocker(MIGRATION_QUESTION)!;
    const text = recoveredAnswerText(b, { repairTaskId: 'abcdef12-0000-0000-0000-000000000000', reused: false, recommended: 'Skip visual QA' });
    expect(text).toContain('abcdef12');
    expect(text).toContain('Skip visual QA');
    expect(text.toLowerCase()).toContain('not sent to a person');
  });
});

describe('fallbackQuestionContext', () => {
  test('rebuilds the context from the needs_input error when the brief has none', () => {
    const ctx = fallbackQuestionContext({ prompt: 'How should I proceed?', workerError: `needs_input: ${MIGRATION_QUESTION}` });
    expect(ctx).toContain('high-water mark');
  });

  test('a plain failure error becomes the context', () => {
    const ctx = fallbackQuestionContext({ prompt: 'Retry?', workerError: 'Visual QA boot failed: migration out of order.' });
    expect(ctx).toBe('Visual QA boot failed: migration out of order.');
  });

  test('an error that only repeats the prompt adds nothing; the task title is used', () => {
    const ctx = fallbackQuestionContext({ prompt: 'How should I proceed?', workerError: 'needs_input: How should I proceed?', taskTitle: 'Surface audit' });
    expect(ctx).toBe('Asked while working on "Surface audit".');
  });

  test('nothing to go on stays absent, never a placeholder', () => {
    expect(fallbackQuestionContext({ prompt: 'How should I proceed?' })).toBeUndefined();
  });
});

describe('isContextFree', () => {
  test('a bare prompt is context-free', () => {
    expect(isContextFree({ prompt: 'How should I proceed?', options: [] })).toBe(true);
  });
  test('context, a recommendation or explained options are enough', () => {
    expect(isContextFree({ prompt: 'How?', context: 'Visual QA cannot boot.', options: [] })).toBe(false);
    expect(isContextFree({ prompt: 'How?', options: [{ label: 'Skip', description: 'Ships without screenshots', recommended: true }] })).toBe(false);
  });
});
