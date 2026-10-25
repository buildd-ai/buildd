// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * A failed task's cause in a few words, for its row (Navigation R-20:
 * `Failed · <what to change>`). Read from the task's error evidence
 * (`tasks.result.error`): a known failure by its name, otherwise the error's
 * first clause with no ids, hashes or paths. Pure.
 */
import { classifyFailure } from './failure-classifier';

const CAUSE_MAX = 60;

const KNOWN: ReadonlyArray<[RegExp, string]> = [
  [/missing acceptance test|test file (?:not found|does not exist)|no test files? found/i, 'test file not found'],
  [/script not found/i, 'script not found'],
  [/merge conflict|CONFLICT \(/i, 'merge conflict'],
  [/timed out|timeout/i, 'timed out'],
  [/session limit|hit your session|budget limit|out of extra usage|max budget/i, 'budget limit'],
];

const CLASS_WORDS: Partial<Record<ReturnType<typeof classifyFailure>, string>> = {
  logic: 'tests failed',
  environmental: 'runner environment',
  transient: 'network or capacity',
};

/** UUIDs, commit hashes, paths: never in a cause (names, never ids). */
const ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b|(?:\S*\/\S+)/i;
const TRAILING_LINK = /\s+(?:for|at|on|in|of|to|with|from|by)$/i;

/** The error's own words when no known name fits: first line, cut before any id, lowercase start, clipped. */
function ownWords(error: string): string | null {
  let s = error.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  s = s.replace(/^(?:error|fatal|failed)\s*:\s*/i, '');
  const id = ID.exec(s);
  if (id) s = s.slice(0, id.index);
  s = s.replace(/[\s:;,.(-]+$/, '');
  while (TRAILING_LINK.test(s)) s = s.replace(TRAILING_LINK, '');
  if (!s) return null;
  if (/^[A-Z][a-z]/.test(s)) s = s.charAt(0).toLowerCase() + s.slice(1);
  if (s.length <= CAUSE_MAX) return s;
  const clipped = s.slice(0, CAUSE_MAX - 1);
  const space = clipped.lastIndexOf(' ');
  return `${(space > CAUSE_MAX / 2 ? clipped.slice(0, space) : clipped).replace(/[\s,;:.]+$/, '')}…`;
}

export function failureCause(error: string | null | undefined): string | null {
  const e = error?.trim();
  if (!e) return null;
  for (const [re, words] of KNOWN) if (re.test(e)) return words;
  return CLASS_WORDS[classifyFailure(e)] ?? ownWords(e);
}

/** The error text in a task's `result` (or its digest), if any. */
export function resultError(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const error = (result as { error?: unknown }).error;
  return typeof error === 'string' ? error : null;
}
