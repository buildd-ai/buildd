/**
 * What a completed task's page leads with: the mission "What shipped" header
 * (knowledge-base: buildd/design/mission-shipped-report.md), one task wide. Pure: the page loads
 * the record, the PR state and the traces; this decides every branch.
 *
 * Top to bottom: eyebrow + plain title + status chips; the lede card (lede,
 * change type, hero shots); "Your move" (one primary action and a meta line);
 * a quiet hiccup row for errors the run recovered from; then the raw handoff
 * behind a Technical summary disclosure. Never the raw handoff as a headline.
 */
import type { ChipTone } from '@/components/ui/Chip';
import type { ShippedChangeType, ShippedHeroShot } from '@/lib/mission-shipped';
import { derivePrDisplayState, type PrDisplayState } from '@/lib/pr-presentation';
import type { TaskShippedRecord } from '@/lib/task-shipped';

export const TASK_SHIPPED_HEADER_ID = 'what-shipped';
export const ERROR_TRACES_ANCHOR = '#agent-error-traces';

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

const SMALL_NUMBERS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];

/** Errors the run matched and got past: a quiet row, never a red chip on a done task. */
export function hiccupLabel(count: number): string | null {
  if (count <= 0) return null;
  if (count === 1) return 'One hiccup, already handled';
  return `${SMALL_NUMBERS[count] ?? count} hiccups, already handled`;
}

export interface ShippedChip {
  label: string;
  tone: ChipTone;
}

export interface ShippedAction {
  label: string;
  href: string;
  tone: 'primary' | 'danger';
}

export interface TaskShippedPr {
  url: string;
  number: number;
  lifecycle: string | null;
  merged: boolean;
}

export interface TaskShippedView {
  eyebrow: string;
  chips: ShippedChip[];
  lede: string | null;
  changeTypeLabel: string | null;
  heroShots: ShippedHeroShot[];
  offPlan: string[];
  /** One full-width primary action, or null when nothing is left to do. */
  action: ShippedAction | null;
  /** Under the action: checks status and the PR number. */
  actionMeta: string | null;
  /** A merged PR, said quietly where the action would be. */
  mergedLine: { label: string; href: string } | null;
  hiccup: { label: string; href: string } | null;
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
  pr: TaskShippedPr | null;
  heroShots: ShippedHeroShot[];
  /** Error traces matched on this task's run. */
  errorTraceCount: number;
  /** The task is attributed to a healthy release. */
  inRelease: boolean;
}

const CHECKS_WORDS: Partial<Record<PrDisplayState, string>> = {
  ci_passed: 'Checks passing',
  ci_running: 'Checks running',
  awaiting_ci: 'Checks running',
  ci_failed: 'Checks failing',
  conflict: 'Merge conflict',
  open: 'Checks not reported',
};

function prChipsAndAction(pr: TaskShippedPr): { chip: ShippedChip | null; action: ShippedAction | null; meta: string | null } {
  const state = derivePrDisplayState(pr.lifecycle, pr.merged ? true : null);
  const meta = CHECKS_WORDS[state] ? `${CHECKS_WORDS[state]} · PR #${pr.number}` : null;
  switch (state) {
    case 'merged':
      return { chip: null, action: null, meta: null };
    case 'closed':
    case 'unresolvable':
      return { chip: { label: 'PR closed', tone: 'muted' }, action: null, meta: null };
    case 'ci_failed':
      return {
        chip: { label: 'Checks failing', tone: 'error' },
        action: { label: 'View failing checks', href: `${pr.url.replace(/\/+$/, '')}/checks`, tone: 'danger' },
        meta,
      };
    case 'conflict':
      return {
        chip: { label: 'Merge conflict', tone: 'warning' },
        action: { label: 'Resolve on GitHub', href: pr.url, tone: 'primary' },
        meta,
      };
    default:
      return {
        chip: { label: 'Waiting on your merge', tone: 'warning' },
        action: { label: 'Review & merge', href: pr.url, tone: 'primary' },
        meta,
      };
  }
}

/**
 * The header for a completed task, or null when the page should render as it
 * always did: not completed, or a planning task (its plan review leads).
 */
export function buildTaskShippedView(input: BuildTaskShippedViewInput): TaskShippedView | null {
  if (input.taskStatus !== 'completed' || input.taskMode === 'planning') return null;

  const merged = !!input.pr?.merged || derivePrDisplayState(input.pr?.lifecycle ?? null, null) === 'merged';
  const shipped = merged || input.inRelease;
  const chips: ShippedChip[] = [shipped ? { label: 'Shipped', tone: 'success' } : { label: 'Done', tone: 'success' }];
  let action: ShippedAction | null = null;
  let actionMeta: string | null = null;
  let mergedLine: TaskShippedView['mergedLine'] = null;
  if (input.pr) {
    const pr = prChipsAndAction({ ...input.pr, merged });
    if (pr.chip) chips.push(pr.chip);
    action = pr.action;
    actionMeta = pr.meta;
    if (merged) mergedLine = { label: `Merged · PR #${input.pr.number}`, href: input.pr.url };
  }

  const record = input.record;
  const lede = record?.lede ?? null;
  const summary = typeof input.summary === 'string' && input.summary.trim() ? input.summary : null;
  const hiccup = hiccupLabel(input.errorTraceCount);

  return {
    eyebrow: shippedEyebrow(input.conventionalType, input.category),
    chips,
    lede,
    changeTypeLabel: record?.changeType ? TASK_CHANGE_TYPE_LABEL[record.changeType] : null,
    heroShots: input.heroShots.slice(0, 3),
    offPlan: lede ? (record?.offPlan ?? []).slice(0, 2) : [],
    action,
    actionMeta,
    mergedLine,
    hiccup: hiccup ? { label: hiccup, href: ERROR_TRACES_ANCHOR } : null,
    technicalSummary: summary,
    technicalSummaryIsFallback: input.summarySource === 'fallback',
  };
}
