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
 * A cloud container runs its whole runner process on a task token, so on a
 * worker a cloud container claimed (workers.claimedByCloud, set by the claim
 * route) a task token counts as the runner. That leaves a known gap: in cloud
 * the agent and the runner share that token and cannot be told apart, so an
 * agent there could still report its own pass. An agent session on a host
 * runner that fell back to the runner key (mint failure, an admin role) is
 * the same gap. Closing either needs a runner-only proof, a separate change.
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

/**
 * True when the caller is the agent rather than the runner: a task token on a
 * worker a host runner claimed. On a cloud-claimed worker the task token is
 * the runner's own credential.
 */
export function agentCredential(
  account: { taskScope?: unknown },
  worker: { claimedByCloud?: boolean | null },
): boolean {
  return !!account.taskScope && worker.claimedByCloud !== true;
}
