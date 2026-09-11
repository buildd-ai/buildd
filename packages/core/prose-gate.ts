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

/**
 * Words/references that indicate the thing a gate phrase points at is an
 * actual trackable unit of work (a task, PR, or its completion event) rather
 * than a human decision like approval or review. A gate phrase only fires
 * when one of these appears in its clause (the match itself through the end
 * of the sentence) — this is what separates "gated on task abc12345 merging"
 * (a real dependency, expressible as dependsOn) from "gated on the owner
 * approving this spec" (a sign-off with no task to link to). Boilerplate like
 * "implementation tasks are gated on the owner approving this spec" contains
 * the word "task" too, but only *before* the phrase, which is why the check
 * looks at the clause after the match rather than the whole description.
 */
const GATE_OBJECT_RE =
  /\b(?:[0-9a-f]{8}|#\d+|merge[sd]?|merging|lands?|landed|landing|ships?|shipped|shipping|complet(?:e|es|ed|ing)|finish(?:es|ed)?|finishing|pass(?:es|ed)?|passing|deploys?|deployed|deploying|releas(?:e|es|ed)?|releasing|done|ready|task|pr|pull request|build)\b/i;

const OBJECT_WINDOW_CHARS = 100;
const CLAUSE_BOUNDARY_RE = /[.!?;\n]/;

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
 * Returns the matched gate phrase plus the rest of its clause (up to the next
 * sentence boundary, capped at OBJECT_WINDOW_CHARS) — the span checked for a
 * real task/PR object via GATE_OBJECT_RE.
 */
function clauseAfterMatch(text: string, matchIndex: number, matchText: string): string {
  const afterStart = matchIndex + matchText.length;
  const rest = text.slice(afterStart, afterStart + OBJECT_WINDOW_CHARS);
  const boundaryIndex = rest.search(CLAUSE_BOUNDARY_RE);
  const clauseTail = boundaryIndex === -1 ? rest : rest.slice(0, boundaryIndex);
  return matchText + clauseTail;
}

/**
 * Scans a task description for prose-declared dependency gates.
 * A gate phrase only counts when its clause names a real task/PR object (an
 * ID reference or a completion-event word like "merging" or "task") — a gate
 * on a human action like approval has nothing a dependsOn edge could point
 * at, so it is not flagged. Returns the literal matched text and any 8-char
 * task-ID-looking tokens found in the description. Returns phrase: null if no
 * gate language is detected.
 */
export function detectProseGate(description: string): ProseGateResult {
  const scanned = stripCodeSpans(description);
  for (const phrase of GATE_PHRASES) {
    const re = new RegExp(phrase, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(scanned)) !== null) {
      const clause = clauseAfterMatch(scanned, match.index, match[0]);
      if (GATE_OBJECT_RE.test(clause)) {
        const taskIds: string[] = [];
        const idRe = /\b([0-9a-f]{8})\b/gi;
        let m: RegExpExecArray | null;
        while ((m = idRe.exec(description)) !== null) {
          taskIds.push(m[1]);
        }
        return { phrase: match[0], taskIds };
      }
    }
  }
  return { phrase: null, taskIds: [] };
}
