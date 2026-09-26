import type { TaskCategoryValue } from '@buildd/shared';

// `research` is absent: it is decided from the title's framing, not by keyword
// search (see RESEARCH_* below). `review` is never emitted (not in CATEGORY_ORDER).
const CATEGORY_KEYWORDS: Record<Exclude<TaskCategoryValue, 'research'>, RegExp[]> = {
  bug: [/\bfix\b/i, /\bbug\b/i, /\bbroken\b/i, /\bcrash/i, /\berror\b/i, /\bregression\b/i],
  feature: [/\badd\b/i, /\bimplement\b/i, /\bnew\b/i, /\bcreate\b/i, /\bbuild\b/i],
  refactor: [/\brefactor/i, /\brename\b/i, /\brestructure/i, /\bcleanup\b/i, /\bmigrat/i],
  chore: [/\bupdate deps/i, /\bbump\b/i, /\bupgrade\b/i, /\bmaintenance\b/i],
  docs: [/\bdocs?\b/i, /\breadme\b/i, /\bdocumentation\b/i, /\bjsdoc\b/i],
  test: [/\btest/i, /\bspec\b/i, /\bcoverage\b/i, /\be2e\b/i],
  infra: [/\bci\b/i, /\bdeploy/i, /\bdocker/i, /\bpipeline\b/i, /\binfra\b/i, /\bconfig\b/i],
  design: [/\bdesign\b/i, /\bui\b/i, /\bux\b/i, /\blayout\b/i, /\bstyle/i, /\bcss\b/i],
  review: [/\breview\b/i, /\breviewer\b/i],
};

// Order matters — more specific categories first to avoid false positives
const CATEGORY_ORDER: Array<keyof typeof CATEGORY_KEYWORDS> = [
  'bug', 'docs', 'test', 'infra', 'design', 'refactor', 'chore', 'feature',
];

/** `type(scope)!: rest` — a conventional-commit style prefix on the title. */
const CONVENTIONAL_PREFIX = /^([a-z]+)(?:\([^)]*\))?!?:\s*/i;

/** Prefixes that declare the task research outright. */
const RESEARCH_PREFIXES = new Set(['research', 'spike', 'investigate', 'investigation', 'explore', 'rfc']);

/**
 * Research is recognised by how the title *opens*, never by a word anywhere in
 * the text: "explore", "compare" and "investigate" turn up in the descriptions
 * of ordinary feature and bug tasks all the time, and "Add a compare view" is a
 * feature.
 */
const RESEARCH_LEAD =
  /^(research|investigate|explore|evaluate|compare|assess|survey|spike|benchmark options|look into|find out|figure out (?:whether|if|how|which)|decide between|what would it take)\b/i;

/**
 * A title that names a failure is a bug investigation, not research — even
 * when it opens with "investigate" or "look into".
 */
const FAILURE_SIGNAL =
  /\b(fail\w*|flak\w*|slow\w*|hang\w*|leak\w*|timeouts?|timing out|broken|crash\w*|errors?|bugs?|regress\w*|not working|stuck|doesn'?t|isn'?t|won'?t|can'?t|500|404)\b/i;

/** Verbs that open an investigation; paired with a failure signal they mean bug. */
const INVESTIGATION_LEAD = /^(investigate|look into|debug|diagnose|figure out|find out|root[- ]cause)\b/i;

function classifyFromTitle(title: string): TaskCategoryValue | null {
  const trimmed = title.trim();
  const prefix = CONVENTIONAL_PREFIX.exec(trimmed);
  if (prefix) {
    // The filer declared a type. Honour a research one; otherwise leave the
    // title to the keyword pass (a `docs:` prefix is not overruled by "compare").
    return RESEARCH_PREFIXES.has(prefix[1].toLowerCase()) ? 'research' : null;
  }
  const failing = FAILURE_SIGNAL.test(trimmed);
  // "Investigate why …" is debugging; "Research why …" is still research.
  if (INVESTIGATION_LEAD.test(trimmed) && (failing || /\bwhy\b/i.test(trimmed))) return 'bug';
  if (!failing && RESEARCH_LEAD.test(trimmed)) return 'research';
  return null;
}

/**
 * Auto-classify a task based on title and description keywords.
 * Returns null if no confident match.
 */
export function classifyTask(title: string, description?: string | null): TaskCategoryValue | null {
  const fromTitle = classifyFromTitle(title);
  if (fromTitle) return fromTitle;

  const text = `${title} ${description || ''}`;

  for (const category of CATEGORY_ORDER) {
    const patterns = CATEGORY_KEYWORDS[category];
    if (patterns.some(p => p.test(text))) {
      return category;
    }
  }

  return null;
}
