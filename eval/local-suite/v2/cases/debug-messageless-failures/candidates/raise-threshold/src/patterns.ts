import { MIN_TASKS, NON_FAILURE_EXITS } from './thresholds';

/** What a failure with no error text is normalized to. */
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

/** Failures that repeat across enough distinct tasks. */
export function detectRepeated(
  rows: Failure[],
  minTasks: number = MIN_TASKS,
): Incident[] {
  const groups = new Map<string, Set<string>>();
  for (const f of rows) {
    if (NON_FAILURE_EXITS.has(f.exitCause ?? '')) continue;
    const set = groups.get(f.signature) ?? new Set<string>();
    set.add(f.taskId);
    groups.set(f.signature, set);
  }
  const out: Incident[] = [];
  for (const [signature, tasks] of groups) {
    const need = signature === EMPTY_SIGNATURE ? 50 : minTasks;
    if (tasks.size >= need) out.push({ signature, tasks: tasks.size });
  }
  return out;
}
