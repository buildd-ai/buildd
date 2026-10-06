/**
 * What a completed task's page leads with: the mission "What shipped" header
 * (knowledge-base: buildd/design/mission-shipped-report.md), one task wide. Pure: the page loads
 * the record, the PR state and the traces; this decides every branch.
 *
 * Eyebrow + plain title; the lede card (lede, change type, hero shots); then
 * the raw handoff behind a Technical summary disclosure. Never the raw handoff
 * as a headline.
 *
 * Where the task stands (shipped, blocked, waiting on you) and what to do
 * next are not decided here: the verdict block (lib/task-verdict.ts) says
 * that once, from the record, above this header's body. The status chips,
 * "Your move" and the "hiccup, already handled" row it used to carry could
 * contradict the verdict (Done beside Checks failing), so they are gone.
 */
import type { ShippedChangeType, ShippedHeroShot } from '@/lib/mission-shipped';
import type { TaskShippedRecord } from '@/lib/task-shipped';

export const TASK_SHIPPED_HEADER_ID = 'what-shipped';

/** Plain words for the owner: where the change shows, not which layer it is in. */
export const TASK_CHANGE_TYPE_LABEL: Record<NonNullable<ShippedChangeType>, string> = {
  frontend: 'On screen',
  backend: 'Behind the scenes',
  both: 'On screen and behind the scenes',
};

const CONVENTIONAL_TYPE_LABEL: Record<string, string> = {
  feat: 'Feature',
  fix: 'Fix',
  hotfix: 'Fix',
  refactor: 'Refactor',
  perf: 'Performance',
  docs: 'Docs',
  doc: 'Docs',
  test: 'Tests',
  tests: 'Tests',
  chore: 'Chore',
  ci: 'CI',
  build: 'Build',
  style: 'Style',
  deps: 'Dependencies',
};

const CATEGORY_LABEL: Record<string, string> = {
  feature: 'Feature',
  bug: 'Fix',
  refactor: 'Refactor',
  chore: 'Chore',
  docs: 'Docs',
  test: 'Tests',
  infra: 'Infra',
  design: 'Design',
  research: 'Research',
};

/** "What shipped · Feature": the title's conventional type first, then the category. */
export function shippedEyebrow(conventionalType: string | null | undefined, category: string | null | undefined): string {
  const type = (conventionalType && CONVENTIONAL_TYPE_LABEL[conventionalType.toLowerCase()])
    || (category && CATEGORY_LABEL[category.toLowerCase()])
    || null;
  return type ? `What shipped · ${type}` : 'What shipped';
}

export interface TaskShippedView {
  eyebrow: string;
  lede: string | null;
  changeTypeLabel: string | null;
  heroShots: ShippedHeroShot[];
  offPlan: string[];
  /** The raw handoff, unchanged, for the Technical summary disclosure. */
  technicalSummary: string | null;
  technicalSummaryIsFallback: boolean;
}

export interface BuildTaskShippedViewInput {
  taskStatus: string;
  taskMode: string | null | undefined;
  conventionalType: string | null;
  category: string | null;
  record: TaskShippedRecord | null;
  summary: string | null | undefined;
  summarySource: string | null | undefined;
  heroShots: ShippedHeroShot[];
}

/**
 * The header for a completed task, or null when the page should render as it
 * always did: not completed, or a planning task (its plan review leads).
 */
export function buildTaskShippedView(input: BuildTaskShippedViewInput): TaskShippedView | null {
  if (input.taskStatus !== 'completed' || input.taskMode === 'planning') return null;

  const record = input.record;
  const lede = record?.lede ?? null;
  const summary = typeof input.summary === 'string' && input.summary.trim() ? input.summary : null;

  return {
    eyebrow: shippedEyebrow(input.conventionalType, input.category),
    lede,
    changeTypeLabel: record?.changeType ? TASK_CHANGE_TYPE_LABEL[record.changeType] : null,
    heroShots: input.heroShots.slice(0, 3),
    offPlan: lede ? (record?.offPlan ?? []).slice(0, 2) : [],
    technicalSummary: summary,
    technicalSummaryIsFallback: input.summarySource === 'fallback',
  };
}
