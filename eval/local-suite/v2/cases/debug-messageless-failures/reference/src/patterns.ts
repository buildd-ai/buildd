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

// Missing text says nothing about sameness. Key those by exit cause,
// and leave them out when that is unknown as well.
function keyOf(f: Failure): string | null {
  if (f.signature !== EMPTY_SIGNATURE) return f.signature;
  return f.exitCause ? `${EMPTY_SIGNATURE} [${f.exitCause}]` : null;
}

/** Failures that repeat across enough distinct tasks. */
export function detectRepeated(
  rows: Failure[],
  minTasks: number = MIN_TASKS,
): Incident[] {
  const groups = new Map<string, Set<string>>();
  for (const f of rows) {
    if (NON_FAILURE_EXITS.has(f.exitCause ?? '')) continue;
    const key = keyOf(f);
    if (key === null) continue;
    const set = groups.get(key) ?? new Set<string>();
    set.add(f.taskId);
    groups.set(key, set);
  }
  const out: Incident[] = [];
  for (const [signature, tasks] of groups) {
    if (tasks.size >= minTasks) out.push({ signature, tasks: tasks.size });
  }
  return out;
}
