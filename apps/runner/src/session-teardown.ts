import { sessionLog } from './session-logger';

/**
 * Minimal shape teardownSession needs from a runner session entry —
 * intentionally not importing WorkerSyncContext's `sessions` map type to
 * avoid a circular dependency with worker-sync.ts.
 */
export interface TeardownableSession {
  inputStream: { end: () => void };
  abortController: AbortController;
  /**
   * Set by reapSession(): the session was aborted as post-completion cleanup,
   * not as an outcome. startSession's catch/post-loop paths read it to skip
   * failure reporting, since the worker already reached its terminal state.
   */
  reapedAt?: number;
}

/**
 * Abort the controller and end the input stream. Each step is independently
 * try/caught: a session that's already half torn down (e.g. the controller
 * already fired) must still get the other step.
 */
function stopSession(session: TeardownableSession, id: string): void {
  try {
    session.abortController.abort();
  } catch (err) {
    sessionLog(id, 'warn', 'teardown_abort_failed', err instanceof Error ? err.message : String(err));
  }

  try {
    session.inputStream.end();
  } catch (err) {
    sessionLog(id, 'warn', 'teardown_stream_end_failed', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Abort the SDK session's controller, end its input stream, and remove it
 * from the sessions map. This is the one sequence that actually stops the
 * underlying `claude` CLI subprocess once its worker record is leaving memory
 * — every such path needs all three steps, not just the map delete.
 */
export function teardownSession(
  sessions: Map<string, TeardownableSession>,
  id: string,
): void {
  const session = sessions.get(id);
  if (!session) return;
  stopSession(session, id);
  sessions.delete(id);
}

/**
 * Abort a session whose worker already finished, WITHOUT removing its map
 * entry. The session's own finally block is conditioned on that entry and is
 * where the per-worker credential, config and CBM dirs get removed — deleting
 * the entry here would skip all of it. `reapedAt` is set BEFORE aborting so
 * the session's catch path sees this abort as cleanup, not a failure.
 */
export function reapSession(session: TeardownableSession, now: number, id: string): void {
  session.reapedAt = now;
  stopSession(session, id);
}
