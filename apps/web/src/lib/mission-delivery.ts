/**
 * The mission Delivery stepper (docs/design/mission-feed-mobile-continuity.md,
 * W2 "Delivery", addendum D5). Pure.
 *
 * One line, directly under the situation, that answers "what is left before
 * this mission is delivered": Integrated → Verified → Visual review → Shipped
 * → Budget. It
 * replaces the progress card, the mission PR card, the release card, the two
 * budget cards and the four completion stat tiles, each of which used to be its
 * own block between the outcome and the task list. A step with nothing to say
 * is hidden, never rendered empty.
 */
import { countDistinctPrs } from '@buildd/core/pr-shipped';
import { deriveMissionProgressSubline, type MissionIntegrationPrView } from './mission-integration-pr';
import type { ReleaseState } from './release-state';

export type DeliveryStepKey = 'integrated' | 'verified' | 'visual' | 'shipped' | 'budget';
export type DeliveryStepState = 'done' | 'partial' | 'todo' | 'blocked';

export const DELIVERY_STATE_GLYPH: Record<DeliveryStepState, string> = {
  done: '●',
  partial: '◐',
  todo: '○',
  blocked: '✕',
};

/** The glyph colour per state, shared by every Delivery step row (summary, default rows, Shipped). */
export const DELIVERY_STATE_TEXT: Record<DeliveryStepState, string> = {
  done: 'text-status-success',
  partial: 'text-status-info',
  todo: 'text-text-muted',
  blocked: 'text-status-error',
};

export const DELIVERY_STEP_LABEL: Record<DeliveryStepKey, string> = {
  integrated: 'Integrated',
  verified: 'Verified',
  visual: 'Visual review',
  shipped: 'Shipped',
  budget: 'Budget',
};

export interface DeliveryStep {
  key: DeliveryStepKey;
  label: string;
  state: DeliveryStepState;
  /** Short value for the one-line summary: `4/6`, `?/3`, `85%`, `–`, `✓`. */
  value: string;
  /** The expanded row's sentence. */
  detail: string;
}

export interface DeliveryInput {
  missionStatus: string;
  /** Deliverable tasks (`computeMissionProgress`). */
  totalTasks: number;
  completedTasks: number;
  awaitingMerge: number;
  integrationPr: MissionIntegrationPrView | null;
  criteria: {
    total: number;
    /** Criteria with a `pass` verdict; null when the gate was never evaluated. */
    passed: number | null;
    overall: string | null;
  };
  /**
   * The latest visual-audit run (`summarizeVisualRun`,
   * docs/design/visual-qa-auditor.md). `null`/absent when the mission has no
   * `[surface audit]` and no audit screenshots, which hides the step.
   */
  visual?: DeliveryVisual | null;
  /**
   * When THIS mission's work reached trunk (`missionTrunkMergedAt`): one entry
   * per merge. Empty when nothing of the mission is on trunk yet.
   */
  mergedAt: readonly string[];
  /**
   * The workspace release baseline (`deliveryReleaseInput`). `null` when the
   * workspace has no release flow or no claimable baseline.
   */
  release: DeliveryRelease | null;
  budget: { budgetUsd: number; spendUsd: number | null; exhausted: boolean } | null;
  /** Completion stats, carried on the Integrated detail instead of stat tiles. */
  prCount?: number;
  durationLabel?: string | null;
}

/** Verdict counts for one visual-audit run. */
export interface DeliveryVisual {
  shots: number;
  ok: number;
  issues: number;
  unsure: number;
  /** Shots the evidence check requires (routes × viewports), when known. */
  required?: number;
  /**
   * Required route × viewport cells the run covers (`requiredCoverage`). The
   * n/m reads this, not `shots`: a re-shoot or an extra route is not coverage.
   */
  covered?: number;
  /** The auditor reported that the app did not boot. */
  bootFailed?: boolean;
}

/**
 * How far the workspace's releases reach. A merge at or before
 * `releasedThrough` has shipped; a later one waits for the next release.
 * `'all'` means the workspace queue is empty, so every merge has shipped.
 */
export interface DeliveryRelease {
  releasedThrough: string | 'all';
}

/**
 * Milliseconds for an ISO string or a Postgres `::text` timestamp
 * (`2026-03-10 12:00:00.12+00`), which `Date.parse` rejects on some engines.
 * NaN when unparseable.
 */
export function timestampMs(value: string): number {
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) return direct;
  return Date.parse(value.trim().replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
}

/** Spend at or above this fraction of the budget earns a Budget step. */
export const BUDGET_WARN_FRACTION = 0.8;

export function buildDeliverySteps(input: DeliveryInput): DeliveryStep[] {
  const steps: DeliveryStep[] = [];
  const { totalTasks, completedTasks } = input;
  const workLanded = totalTasks > 0 && completedTasks >= totalTasks;

  if (totalTasks > 0) {
    const missionPrPending = input.integrationPr != null && input.integrationPr.state !== 'merged';
    const state: DeliveryStepState = workLanded && !missionPrPending ? 'done' : completedTasks > 0 || workLanded ? 'partial' : 'todo';
    const stats = [
      input.prCount != null && input.prCount > 0 ? `${input.prCount} PR${input.prCount === 1 ? '' : 's'}` : null,
      input.durationLabel ?? null,
    ].filter(Boolean);
    const subline = deriveMissionProgressSubline({
      missionStatus: input.missionStatus,
      totalTasks,
      completedTasks,
      awaitingMerge: input.awaitingMerge,
      integrationPr: input.integrationPr,
    });
    steps.push({
      key: 'integrated',
      label: DELIVERY_STEP_LABEL.integrated,
      state,
      value: `${completedTasks}/${totalTasks}`,
      detail: [subline, ...stats].join(' · '),
    });
  }

  const { criteria } = input;
  if (criteria.total > 0) {
    const passed = criteria.passed;
    const state: DeliveryStepState =
      criteria.overall === 'pass' ? 'done'
        : criteria.overall === 'fail' ? 'blocked'
          : passed != null && passed > 0 ? 'partial'
            : 'todo';
    steps.push({
      key: 'verified',
      label: DELIVERY_STEP_LABEL.verified,
      state,
      value: `${passed ?? '?'}/${criteria.total}`,
      detail: passed == null ? `${criteria.total} criteria, not yet evaluated` : `${passed} of ${criteria.total} criteria pass`,
    });
  }

  if (input.visual) steps.push(visualStep(input.visual));

  // D6: the Shipped step is this mission's fact. The workspace queue depth
  // never decides it: only this mission's merges, read against the release
  // baseline, do. Nothing merged, or no claimable baseline, hides the step.
  const shipped = shippedStep(input, workLanded);
  if (shipped) steps.push(shipped);

  const { budget } = input;
  if (budget) {
    if (budget.exhausted) {
      steps.push({ key: 'budget', label: DELIVERY_STEP_LABEL.budget, state: 'blocked', value: 'cap', detail: 'paused at cap' });
    } else if (budget.spendUsd != null && budget.budgetUsd > 0 && budget.spendUsd / budget.budgetUsd >= BUDGET_WARN_FRACTION) {
      const pct = Math.round((budget.spendUsd / budget.budgetUsd) * 100);
      steps.push({ key: 'budget', label: DELIVERY_STEP_LABEL.budget, state: 'partial', value: `${pct}%`, detail: `${pct}% of budget used` });
    }
  }

  return steps;
}

/**
 * Verdicts are advisory (docs/design/visual-qa-auditor.md, "The gate"): an
 * issue or an unsure shot is `partial`, never `blocked`. The filed fix task or
 * the open question is what holds the mission. Only a boot failure blocks,
 * because then nobody looked at anything, and that must be loud.
 */
function visualStep(v: DeliveryVisual): DeliveryStep {
  const base = { key: 'visual' as const, label: DELIVERY_STEP_LABEL.visual };
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (v.bootFailed) {
    return { ...base, state: 'blocked', value: 'boot', detail: 'the app did not boot for the visual audit' };
  }
  if (v.shots === 0) {
    return { ...base, state: 'todo', value: '–', detail: 'waiting for the visual audit' };
  }
  if (v.issues > 0 || v.unsure > 0) {
    const value = [v.issues > 0 ? `${v.issues}✕` : null, v.unsure > 0 ? `${v.unsure}?` : null].filter(Boolean).join(' ');
    const detail = [
      plural(v.shots, 'shot'),
      v.issues > 0 ? plural(v.issues, 'issue') : null,
      v.unsure > 0 ? `${v.unsure} unsure` : null,
    ].filter(Boolean).join(' · ');
    return { ...base, state: 'partial', value, detail };
  }
  const covered = v.covered ?? v.shots;
  if (v.required != null && covered < v.required) {
    return { ...base, state: 'partial', value: `${covered}/${v.required}`, detail: `${covered} of ${v.required} required shots, all ok` };
  }
  return { ...base, state: 'done', value: plural(v.shots, 'shot'), detail: `${plural(v.shots, 'shot')}, all ok` };
}

function shippedStep(input: DeliveryInput, workLanded: boolean): DeliveryStep | null {
  const { release } = input;
  if (!release) return null;
  const merges = input.mergedAt.map(timestampMs).filter(t => !Number.isNaN(t));
  if (merges.length === 0) return null;
  const through = release.releasedThrough === 'all' ? Infinity : timestampMs(release.releasedThrough);
  if (Number.isNaN(through)) return null;

  const waiting = merges.filter(t => t > through).length;
  const base = { key: 'shipped' as const, label: DELIVERY_STEP_LABEL.shipped };
  if (waiting > 0) {
    return { ...base, state: waiting < merges.length ? 'partial' : 'todo', value: '–', detail: 'after next release' };
  }
  return workLanded
    ? { ...base, state: 'done', value: '✓', detail: 'released' }
    : { ...base, state: 'partial', value: '–', detail: 'landed work is released; the rest ships after it merges' };
}

/**
 * The workspace release ledger (`classifyReleaseState`), reduced to the one
 * thing a mission's Shipped step may read: how far releases reach. A gated
 * workspace reaches its baseline (the last release); a clean gated queue
 * reaches everything; a healthy continuous deploy reaches its deploy time.
 * Everything else — no flow, no baseline, a deploy in flight or failing —
 * claims nothing and hides the step.
 */
export function deliveryReleaseInput(state: ReleaseState): DeliveryRelease | null {
  if (state.state === 'unseeded') {
    if (state.archetype === 'gated') return state.baselineAsOf ? { releasedThrough: state.baselineAsOf } : null;
    if (state.deployState !== 'healthy') return null;
    const at = state.healthyAt ?? state.deployedAt;
    return at ? { releasedThrough: at } : null;
  }
  if (state.state === 'clean' && state.reason === 'zero_queue') return { releasedThrough: 'all' };
  return null;
}

interface TrunkTaskLike {
  id: string;
  workers?: ReadonlyArray<{ mergedAt?: string | Date | null }> | null;
}

/**
 * When this mission's work reached trunk. Without an integration branch,
 * every worker merge. With one (Option A′), task PRs merge into the mission
 * branch and reach trunk only through the integration PR, so only that PR's
 * merge counts, and nothing does until it merges
 * (`@buildd/core/release-queue-scope`, the same question the queue asks).
 */
export function missionTrunkMergedAt(
  tasks: readonly TrunkTaskLike[],
  integrationPr: MissionIntegrationPrView | null,
): string[] {
  const iso = (d: string | Date) => (typeof d === 'string' ? d : d.toISOString());
  const mergesOf = (t: TrunkTaskLike) =>
    (t.workers ?? []).flatMap(w => (w.mergedAt ? [iso(w.mergedAt)] : []));
  if (integrationPr) {
    if (integrationPr.state !== 'merged' || !integrationPr.taskId) return [];
    const owner = tasks.find(t => t.id === integrationPr.taskId);
    return owner ? mergesOf(owner) : [];
  }
  return tasks.flatMap(mergesOf);
}

/**
 * The Integrated step's "N PRs": distinct PRs across the mission's workers.
 * A CI-retry task pushes to its parent's PR, so counting worker rows put one
 * more PR on this step than the `all_prs_merged` evidence names.
 */
export function missionPrCount(
  tasks: ReadonlyArray<{ workers?: ReadonlyArray<{ prUrl?: string | null }> | null }>,
): number {
  return countDistinctPrs(tasks.flatMap(t => t.workers ?? []));
}

/** `Integrated ◐ 4/6 · Verified ◐ 2/3 · Shipped ○ –` */
export function formatDeliverySummary(steps: readonly DeliveryStep[]): string {
  return steps.map(s => `${s.label} ${DELIVERY_STATE_GLYPH[s.state]} ${s.value}`).join(' · ');
}
