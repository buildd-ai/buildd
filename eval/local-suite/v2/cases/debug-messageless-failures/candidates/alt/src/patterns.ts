import { MIN_TASKS, NON_FAILURE_EXITS } from './thresholds';

export const EMPTY_SIGNATURE = '(no error message)';

export interface Failure {
  workerId: string;
  taskId: string;
  signature: string;
  exitCause: string | null;
}

export interface Incident {
  signature: string;
  tasks: number;
}

export function detectRepeated(
  rows: Failure[],
  minTasks: number = MIN_TASKS,
): Incident[] {
  const named = new Map<string, Set<string>>();
  const bySignature = (f: Failure) =>
    f.signature === EMPTY_SIGNATURE
      ? `${f.signature}#${f.exitCause ?? ''}`
      : f.signature;
  const usable = rows.filter(
    (f) =>
      !NON_FAILURE_EXITS.has(f.exitCause ?? '') &&
      !(f.signature === EMPTY_SIGNATURE && !f.exitCause),
  );
  for (const f of usable) {
    const k = bySignature(f);
    named.set(k, (named.get(k) ?? new Set()).add(f.taskId));
  }
  return [...named]
    .filter(([, t]) => t.size >= minTasks)
    .map(([signature, t]) => ({ signature, tasks: t.size }));
}
