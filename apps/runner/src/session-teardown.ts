import { sessionLog } from './session-logger';

/**
 * Minimal shape teardownSession needs from a runner session entry —
 * intentionally not importing WorkerSyncContext's `sessions` map type to
 * avoid a circular dependency with worker-sync.ts.
 */
export interface TeardownableSession {
  inputStream: { end: () => void };
  abortController: AbortController;
}

/**
 * Abort the SDK session's controller, end its input stream, and remove it
 * from the sessions map. This is the one sequence that actually stops the
 * underlying `claude` CLI subprocess — every termination path needs to run
 * all three steps, not just drop the map entry. Each step is independently
 * try/caught: a session that's already half torn down (e.g. the controller
 * already fired) must still reach the map delete.
 */
export function teardownSession(
  sessions: Map<string, TeardownableSession>,
  id: string,
): void {
  const session = sessions.get(id);
  if (!session) return;

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

  sessions.delete(id);
}
