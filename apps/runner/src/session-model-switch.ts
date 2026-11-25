/**
 * A model change made while a session exists (resume in place).
 *
 * The server decides the model a session continues on when the task's tier or
 * model was changed during the run. It answers the runner's own resume call
 * (`status: running, reactivate: true, takesSessionModel: true`) with
 * `sessionModel`, and the runner adopts it before it resumes: every resume
 * path rebuilds its task from `worker.sessionModel` (recovery.ts
 * sessionModelContext), so the same session, Claude by session id or Codex by
 * thread id, continues on the new model. The transcript is kept; the prompt
 * cache is not.
 *
 * A runner told to ignore per-task models (BUILDD_HONOR_TASK_MODEL=0) does not
 * say it takes one, so the server never records a switch that did not happen.
 */
import type { LocalWorker } from './types';
import { honorTaskModelEnabled } from './prompt-builder';

/** Whether the resume call should say this runner takes a model from the server. */
export function takesSessionModel(env: NodeJS.ProcessEnv = process.env): boolean {
  return honorTaskModelEnabled(env);
}

/**
 * Adopt the model the server answered a resume call with. Returns the switch
 * when the session's model changed, null when there was nothing to adopt.
 */
export function adoptServerSessionModel(
  worker: Pick<LocalWorker, 'sessionModel' | 'claimedModel'>,
  response: unknown,
  env: NodeJS.ProcessEnv = process.env,
): { from: string | null; to: string } | null {
  if (!takesSessionModel(env)) return null;
  const raw = (response as { sessionModel?: unknown } | null | undefined)?.sessionModel;
  const to = typeof raw === 'string' ? raw.trim() : '';
  if (!to || to === worker.sessionModel) return null;
  const from = worker.sessionModel ?? null;
  worker.sessionModel = to;
  worker.claimedModel = to;
  return { from, to };
}
