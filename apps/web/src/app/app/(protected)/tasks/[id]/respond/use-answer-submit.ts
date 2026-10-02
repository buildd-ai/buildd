'use client';

/**
 * The client half every answer surface shares: one submission at a time, the
 * tapped option pending while it is in flight, and the outcome held as
 * optimistic state the moment the server accepts it (no refetch or Pusher
 * event needed to say so).
 *
 * The outcome claims server truth, so it never outlives the server state it
 * answered (the action-card rule I-1, as in WaitingOnYouReviewCard): it clears whenever
 * `resetKey`, derived from server props, changes. Pick a key that the answer
 * itself does not change (the worker id, plus whatever means the agent has
 * picked the answer up), or the confirmation vanishes on the first refetch.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNeedsInput } from '@/components/needs-input-context';
import { AnswerSubmitError, submitAnswer, type AnswerOutcome, type SubmitAnswerInput } from './submit-answer';

export interface AnswerSubmitState {
  /** Send an answer. A call while one is in flight is dropped. */
  submit: (message: string) => Promise<void>;
  /** The answer in flight, if any. */
  sending: string | null;
  /** What the server recorded, until `resetKey` changes. */
  outcome: AnswerOutcome | null;
  /** A real failure: the question is still open, so retry is the same tap. */
  error: { message: string; credentialRevoked: boolean } | null;
}

export function useAnswerSubmit(opts: {
  workerId: string | null;
  taskId?: string | null;
  noteId?: string | null;
  resetKey: string;
  onAnswered?: (outcome: AnswerOutcome) => void | Promise<void>;
  /** Injectable for tests and fixtures. */
  send?: (input: SubmitAnswerInput) => Promise<AnswerOutcome>;
}): AnswerSubmitState {
  const { workerId, taskId = null, noteId = null, resetKey, onAnswered, send = submitAnswer } = opts;
  const { markAnswerSent } = useNeedsInput();
  // A ref, not state: two taps inside one render frame both see `sending`
  // still null, and the second would post a duplicate.
  const inFlight = useRef(false);
  const [sending, setSending] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AnswerOutcome | null>(null);
  const [error, setError] = useState<AnswerSubmitState['error']>(null);

  useEffect(() => {
    setOutcome(null);
    setError(null);
  }, [resetKey]);

  const submit = useCallback(async (message: string) => {
    const text = message.trim();
    if (!workerId || !text || inFlight.current) return;
    inFlight.current = true;
    setSending(text);
    setError(null);
    try {
      const result = await send({ workerId, taskId, noteId, message: text });
      setOutcome(result);
      if (taskId) markAnswerSent?.(taskId);
      await onAnswered?.(result);
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'Failed to send answer',
        credentialRevoked: err instanceof AnswerSubmitError && err.credentialRevoked,
      });
    } finally {
      inFlight.current = false;
      setSending(null);
    }
  }, [workerId, taskId, noteId, send, markAnswerSent, onAnswered]);

  return { submit, sending, outcome, error };
}
