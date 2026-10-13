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
import { AnswerSubmitError, submitAnswer, type AnswerOutcome, type StaleAnswerNotice, type SubmitAnswerInput } from './submit-answer';

export interface AnswerSubmitFailure {
  message: string;
  credentialRevoked: boolean;
  /** The agent stopped waiting after the card rendered: say where the work went, not "try again". */
  stale?: StaleAnswerNotice | null;
}

export interface AnswerSubmitState {
  /**
   * Send an answer. A call while one is in flight is dropped. `noteId`, when
   * the card knows the question note recording the same ask, marks it answered
   * (it wins over the hook's own).
   */
  submit: (message: string, opts?: { noteId?: string | null }) => Promise<void>;
  /** The answer in flight, if any. */
  sending: string | null;
  /** What the server recorded, until `resetKey` changes. */
  outcome: AnswerOutcome | null;
  /** A failure. Without `stale` the question is still open, so retry is the same tap. */
  error: AnswerSubmitFailure | null;
}

export function useAnswerSubmit(opts: {
  workerId: string | null;
  taskId?: string | null;
  noteId?: string | null;
  resetKey: string;
  onAnswered?: (outcome: AnswerOutcome) => void | Promise<void>;
  /** Called with each failure, for state that must outlive `resetKey` (the task page's stale notice). */
  onError?: (error: AnswerSubmitFailure) => void;
  /** Injectable for tests and fixtures. */
  send?: (input: SubmitAnswerInput) => Promise<AnswerOutcome>;
}): AnswerSubmitState {
  const { workerId, taskId = null, noteId = null, resetKey, onAnswered, onError, send = submitAnswer } = opts;
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

  const submit = useCallback(async (message: string, call?: { noteId?: string | null }) => {
    const text = message.trim();
    if (!workerId || !text || inFlight.current) return;
    inFlight.current = true;
    setSending(text);
    setError(null);
    try {
      const result = await send({ workerId, taskId, noteId: call?.noteId ?? noteId, message: text });
      setOutcome(result);
      if (taskId) markAnswerSent?.(taskId);
      await onAnswered?.(result);
    } catch (err) {
      const failure: AnswerSubmitFailure = {
        message: err instanceof Error ? err.message : 'Failed to send answer',
        credentialRevoked: err instanceof AnswerSubmitError && err.credentialRevoked,
        stale: err instanceof AnswerSubmitError ? err.stale : null,
      };
      setError(failure);
      onError?.(failure);
    } finally {
      inFlight.current = false;
      setSending(null);
    }
  }, [workerId, taskId, noteId, send, markAnswerSent, onAnswered, onError]);

  return { submit, sending, outcome, error };
}
