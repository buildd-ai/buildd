/**
 * GATE_PHRASES lists case-insensitive patterns that indicate a task description
 * is declaring a dependency gate in prose rather than as dependsOn edges.
 * Stored as data (not inlined regex) so the list can be tuned without touching
 * the matcher logic.
 */
export const GATE_PHRASES: readonly string[] = [
  'gated on',
  'gates on',
  'depends on',
  'must not run in parallel',
  'blocked on',
  'after .+ merges?',
  'once .+ is merged',
  'wait for',
];

export interface ProseGateResult {
  /** The matched phrase pattern, or null if no gate language was detected. */
  phrase: string | null;
  /** 8-char lowercase hex tokens found in the description (likely task IDs). */
  taskIds: string[];
}

/**
 * Scans a task description for prose-declared dependency gates.
 * Returns the first matched phrase pattern and any 8-char task-ID-looking tokens
 * found in the description. Returns phrase: null if no gate language is detected.
 */
export function detectProseGate(description: string): ProseGateResult {
  for (const phrase of GATE_PHRASES) {
    if (new RegExp(phrase, 'i').test(description)) {
      const taskIds: string[] = [];
      const idRe = /\b([0-9a-f]{8})\b/gi;
      let m: RegExpExecArray | null;
      while ((m = idRe.exec(description)) !== null) {
        taskIds.push(m[1]);
      }
      return { phrase, taskIds };
    }
  }
  return { phrase: null, taskIds: [] };
}
