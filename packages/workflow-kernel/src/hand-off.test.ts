import { describe, expect, test } from 'bun:test';
import { attemptEndFromPatch, taskRetryCoversAttemptEnd } from './hand-off';

const base = { fallbackLocalHeadSha: 'W1', fallbackCommitCount: 4 };

describe('attemptEndFromPatch (S30)', () => {
  test('a failed PATCH carrying outcome=unproven ends the attempt unproven with the runner-reported head and count', () => {
    expect(attemptEndFromPatch({ ...base, status: 'failed', outcome: 'unproven', localHeadSha: 'L3', commitCount: 2 }))
      .toEqual({ status: 'unproven', localHeadSha: 'L3', commitCount: 2 });
  });

  test('an old runner that omits the fields gets exactly today\'s mapping', () => {
    expect(attemptEndFromPatch({ ...base, status: 'failed' })).toEqual({ status: 'failed', localHeadSha: 'W1', commitCount: 4 });
    expect(attemptEndFromPatch({ ...base, status: 'completed' })).toEqual({ status: 'completed', localHeadSha: 'W1', commitCount: 4 });
  });

  test('unproven only qualifies a failure: a completed PATCH stays completed', () => {
    expect(attemptEndFromPatch({ ...base, status: 'completed', outcome: 'unproven', localHeadSha: 'L3', commitCount: 2 }).status).toBe('completed');
  });

  test('malformed fields fall back instead of reaching the reducer', () => {
    expect(attemptEndFromPatch({ ...base, status: 'failed', outcome: 'UNPROVEN', localHeadSha: '  ', commitCount: -1 }))
      .toEqual({ status: 'failed', localHeadSha: 'W1', commitCount: 4 });
    expect(attemptEndFromPatch({ ...base, status: 'failed', outcome: 'unproven', localHeadSha: 7, commitCount: 'two' }))
      .toEqual({ status: 'unproven', localHeadSha: 'W1', commitCount: 4 });
  });

  test('an unproven end with nothing local carries commitCount 0', () => {
    expect(attemptEndFromPatch({ ...base, status: 'failed', outcome: 'unproven', localHeadSha: null, commitCount: 0, fallbackLocalHeadSha: null }))
      .toEqual({ status: 'unproven', localHeadSha: null, commitCount: 0 });
  });
});

describe('taskRetryCoversAttemptEnd', () => {
  const none = { localHeadSha: null, commitCount: 0 };
  const some = { localHeadSha: 'L', commitCount: 3 };
  test('no task retry: every end is reported', () => {
    expect(taskRetryCoversAttemptEnd({ status: 'failed', ...none }, false, 'fix')).toBe(false);
  });
  test('a retried plain failure is the requeue, not an attempt end (§5.7 rule 2) — old runners unchanged', () => {
    expect(taskRetryCoversAttemptEnd({ status: 'failed', ...some }, true, 'owner')).toBe(true);
    expect(taskRetryCoversAttemptEnd({ status: 'failed', ...none }, true, 'fix')).toBe(true);
  });
  test('an unproven end with local commits is reported even while the task retries: the work exists, only a push is missing', () => {
    expect(taskRetryCoversAttemptEnd({ status: 'unproven', ...some }, true, 'owner')).toBe(false);
    expect(taskRetryCoversAttemptEnd({ status: 'unproven', ...some }, true, 'fix')).toBe(false);
  });
  test('an unproven owner end with nothing local is reported so the kernel records the requeue; a repair one stays covered (no second fix)', () => {
    expect(taskRetryCoversAttemptEnd({ status: 'unproven', ...none }, true, 'owner')).toBe(false);
    expect(taskRetryCoversAttemptEnd({ status: 'unproven', ...none }, true, 'fix')).toBe(true);
  });
});
