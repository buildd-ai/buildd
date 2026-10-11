/**
 * Where a worker's verification evidence came from.
 *
 * The runner runs a task's verification command and reports the exit code on
 * the worker (workers.verificationEvidence). On a host runner it does so with
 * its runner key, while the agent session it spawned holds a per-task token
 * (apps/runner/src/agent-task-token.ts) that may PATCH the same worker. So
 * evidence that arrives on a task token is the agent's word, not the runner's
 * run, and a verdict that must rest on the exit code (a spec criterion check,
 * a mission `command` goal criterion) never rests on it.
 *
 * The server stamps `reportedVia` on every stored copy; a caller cannot set
 * it. Evidence stored before the stamp existed keeps its old meaning.
 *
 * Not solved here: a cloud container runs its whole runner process on a task
 * token, so its evidence reads `task_token` too and those verdicts stay
 * unverified; and an agent session that fell back to the runner key (mint
 * failure, an admin role) cannot be told from the runner. Both need a
 * runner-only proof (a signed evidence field), which is a separate change.
 */

export type ReportedVia = 'runner' | 'task_token';

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The evidence as stored: the caller's fields, with the server's own `reportedVia`. */
export function stampEvidence(evidence: unknown, opts: { viaTaskToken: boolean }): Record<string, unknown> | null {
  const ev = asRecord(evidence);
  if (!ev) return null;
  const { reportedVia: _ignored, ...rest } = ev;
  return { ...rest, reportedVia: opts.viaTaskToken ? 'task_token' : 'runner' };
}

/** True unless the evidence arrived on a task token. Absent evidence is not runner evidence. */
export function isRunnerReported(evidence: unknown): boolean {
  const ev = asRecord(evidence);
  return !!ev && ev.reportedVia !== 'task_token';
}

/** A task-token write never replaces evidence the runner recorded. */
export function keepStoredEvidence(incoming: unknown, stored: unknown): boolean {
  return !isRunnerReported(incoming) && isRunnerReported(stored);
}

/** The evidence a completion is decided on: the body's, unless only the stored copy is the runner's. */
export function evidenceForCompletion<T>(body: T | null | undefined, stored: T | null | undefined): T | null {
  if (body == null) return stored ?? null;
  return keepStoredEvidence(body, stored) ? (stored as T) : body;
}
