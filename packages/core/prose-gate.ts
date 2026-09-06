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
  /** The literal text that matched, or null if no gate language was detected. */
  phrase: string | null;
  /** 8-char lowercase hex tokens found in the description (likely task IDs). */
  taskIds: string[];
}

/**
 * Descriptions quote code and candidate trigger phrases in backticks (e.g. an
 * `if` statement, or a list of phrases like `blocked on` proposed as matchers).
 * Stripping code spans before scanning avoids matching gate language that is
 * itself the subject being discussed rather than a real dependency declaration.
 */
function stripCodeSpans(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/**
 * Scans a task description for prose-declared dependency gates.
 * Returns the literal matched text and any 8-char task-ID-looking tokens found
 * in the description. Returns phrase: null if no gate language is detected.
 */
export function detectProseGate(description: string): ProseGateResult {
  const scanned = stripCodeSpans(description);
  for (const phrase of GATE_PHRASES) {
    const match = new RegExp(phrase, 'i').exec(scanned);
    if (match) {
      const taskIds: string[] = [];
      const idRe = /\b([0-9a-f]{8})\b/gi;
      let m: RegExpExecArray | null;
      while ((m = idRe.exec(description)) !== null) {
        taskIds.push(m[1]);
      }
      return { phrase: match[0], taskIds };
    }
  }
  return { phrase: null, taskIds: [] };
}
