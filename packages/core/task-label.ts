/**
 * Short task labels — the "scope chip + 2–4 word label" every task is drawn as.
 *
 * Whoever files a task may supply `tasks.label`; when they don't, the creation
 * path stores {@link heuristicTaskLabel}'s output, and {@link taskDisplayLabel}
 * re-derives it for any row that still has none (rows filed before the column
 * existed, and system insert sites that never set it). Pure and deterministic
 * so server, runner and client all draw the same label for the same title.
 */

/** Width of the `tasks.label` column. A supplied label is capped to this. */
export const TASK_LABEL_MAX_LENGTH = 48;

/** A derived label is shorter than the column: it has to fit a chip. */
const HEURISTIC_MAX_LENGTH = 32;
const HEURISTIC_MAX_WORDS = 4;
const SCOPE_MAX_LENGTH = 24;
const FALLBACK_LABEL = 'untitled';

const CONVENTIONAL_RE =
  /^(feat|fix|chore|docs?|refactor|tests?|ci|perf|build|style|revert|hotfix|release|deps)(?:\(([^)]*)\))?!?:\s*/i;

/** `[builder · after CI #1]`, `[CI Retry]`, `[friction]` … */
const BRACKET_PREFIX_RE = /^\s*\[[^\]]*\]\s*/;

/** System title prefixes, and the verb (if any) the label should keep. */
const TITLE_PREFIXES: Array<[RegExp, string | null]> = [
  [/^verify goal criterion:\s*/i, 'verify'],
  [/^verify:\s*/i, 'verify'],
  [/^review:\s*/i, 'review'],
  [/^mission:\s*/i, null],
  // Researcher titles ("RESEARCH: FX rate providers — …"): the prefix names
  // the role, the subject names the task.
  [/^research:\s*/i, null],
  [/^(?:ci\s+)?retry:\s*/i, null],
  [/^follow-?up:\s*/i, null],
];

/** Where a subject's first clause ends. */
const CLAUSE_BREAK_RE = /\s[—–-]\s|:\s|;\s|,\s|\s\(|\.\s|\s\|\s/;

const ARTICLES = new Set(['the', 'a', 'an']);

/**
 * Connectors that end the head noun phrase. Once the label has two words, the
 * first of these stops it; before that they are skipped ("support for dark
 * mode" → "support dark mode").
 */
const CONNECTORS = new Set([
  'with', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'at', 'by', 'from', 'via',
  'into', 'onto', 'so', 'that', 'which', 'when', 'while', 'instead', 'because',
  'using', 'without', 'after', 'before', 'if', 'unless', 'than', 'vs', 'per', 'as', 'but',
]);

/** Leading verbs that carry no information in a label ("add X" → "X"). */
const EMPTY_LEADING_VERBS = new Set(['add', 'adds', 'added', 'implement', 'introduce', 'create']);

export function normalizeTaskLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  return capAtWord(collapsed, TASK_LABEL_MAX_LENGTH, false);
}

function capAtWord(text: string, max: number, ellipsis: boolean): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1).lastIndexOf(' ');
  if (cut > 0) return text.slice(0, cut).trimEnd();
  return ellipsis ? `${text.slice(0, max - 1)}…` : text.slice(0, max);
}

function cleanWord(word: string): string {
  return word.replace(/^["'`“‘(]+/, '').replace(/["'`”’).,;:!?]+$/, '');
}

function displayCase(word: string): string {
  // "Investigate" → "investigate"; "FX", "PRs", "create_task" stay verbatim.
  return /^[A-Z][a-z]+$/.test(word) ? word.toLowerCase() : word;
}

function parseTitle(title: string): { scope: string | null; subject: string; verb: string | null } {
  let rest = title.trim();
  let verb: string | null = null;

  // Peel retry brackets and system prefixes in any order until none match.
  for (let guard = 0; guard < 10; guard++) {
    const before = rest;
    rest = rest.replace(BRACKET_PREFIX_RE, '');
    for (const [re, prefixVerb] of TITLE_PREFIXES) {
      if (re.test(rest)) {
        rest = rest.replace(re, '');
        if (prefixVerb) verb = prefixVerb;
      }
    }
    if (rest === before) break;
  }

  let scope: string | null = null;
  const conventional = CONVENTIONAL_RE.exec(rest);
  if (conventional) {
    const rawScope = (conventional[2] ?? '').trim();
    scope = rawScope ? rawScope.slice(0, SCOPE_MAX_LENGTH) : null;
    rest = rest.slice(conventional[0].length);
  }

  return { scope, subject: rest.trim(), verb };
}

function labelFromSubject(subject: string, verb: string | null): string {
  const breakAt = subject.search(CLAUSE_BREAK_RE);
  const clause = (breakAt > 0 ? subject.slice(0, breakAt) : subject).trim();
  const raw = clause.split(/\s+/).map(cleanWord).filter(Boolean);
  const maxWords = verb ? HEURISTIC_MAX_WORDS - 1 : HEURISTIC_MAX_WORDS;

  let words = raw;
  if (words.length > 2 && EMPTY_LEADING_VERBS.has(words[0].toLowerCase())) words = words.slice(1);

  const picked: string[] = [];
  for (const word of words) {
    const lower = word.toLowerCase();
    if (ARTICLES.has(lower)) continue;
    if (CONNECTORS.has(lower)) {
      if (picked.length >= 2) break;
      continue;
    }
    picked.push(displayCase(word));
    if (picked.length >= maxWords) break;
  }

  // A subject made only of filler still gets drawn as something.
  const chosen = picked.length > 0 ? picked : raw.slice(0, maxWords);
  if (chosen.length === 0) return verb ?? FALLBACK_LABEL;
  if (verb) chosen.unshift(verb);

  while (chosen.length > 1 && chosen.join(' ').length > HEURISTIC_MAX_LENGTH) chosen.pop();
  return capAtWord(chosen.join(' '), HEURISTIC_MAX_LENGTH, true);
}

/** The derived label for a title, ignoring any stored `label`. */
export function heuristicTaskLabel(title: string): { scope: string | null; label: string } {
  const { scope, subject, verb } = parseTitle(title ?? '');
  return { scope, label: labelFromSubject(subject, verb) };
}

/**
 * The scope chip + short label a task is drawn with. Uses the creator- or
 * classifier-supplied `task.label` when present; otherwise derives one from
 * the title. The scope always comes from the title's conventional-commit scope.
 */
export function taskDisplayLabel(task: { label?: string | null; title: string }): { scope: string | null; label: string } {
  const derived = heuristicTaskLabel(task.title);
  const supplied = normalizeTaskLabel(task.label);
  return supplied ? { scope: derived.scope, label: supplied } : derived;
}
