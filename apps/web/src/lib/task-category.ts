import type { TaskCategoryValue } from '@buildd/shared';

const CATEGORY_KEYWORDS: Record<TaskCategoryValue, RegExp[]> = {
  bug: [/\bfix\b/i, /\bbug\b/i, /\bbroken\b/i, /\bcrash/i, /\berror\b/i, /\bregression\b/i],
  feature: [/\badd\b/i, /\bimplement\b/i, /\bnew\b/i, /\bcreate\b/i, /\bbuild\b/i],
  refactor: [/\brefactor/i, /\brename\b/i, /\brestructure/i, /\bcleanup\b/i, /\bmigrat/i],
  chore: [/\bupdate deps/i, /\bbump\b/i, /\bupgrade\b/i, /\bmaintenance\b/i],
  docs: [/\bdocs?\b/i, /\breadme\b/i, /\bdocumentation\b/i, /\bjsdoc\b/i],
  test: [/\btest/i, /\bspec\b/i, /\bcoverage\b/i, /\be2e\b/i],
  infra: [/\bci\b/i, /\bdeploy/i, /\bdocker/i, /\bpipeline\b/i, /\binfra\b/i, /\bconfig\b/i],
  design: [/\bdesign\b/i, /\bui\b/i, /\bux\b/i, /\blayout\b/i, /\bstyle/i, /\bcss\b/i],
};

// Order matters — more specific categories first to avoid false positives
const CATEGORY_ORDER: TaskCategoryValue[] = [
  'bug', 'docs', 'test', 'infra', 'design', 'refactor', 'chore', 'feature',
];

/**
 * Auto-classify a task based on title and description keywords.
 * Returns null if no confident match.
 */
export function classifyTask(title: string, description?: string | null): TaskCategoryValue | null {
  const text = `${title} ${description || ''}`;

  for (const category of CATEGORY_ORDER) {
    const patterns = CATEGORY_KEYWORDS[category];
    if (patterns.some(p => p.test(text))) {
      return category;
    }
  }

  return null;
}
