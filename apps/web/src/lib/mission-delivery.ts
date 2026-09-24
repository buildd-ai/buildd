/**
 * The mission Delivery stepper (docs/design/mission-feed-mobile-continuity.md,
 * W2 "Delivery", addendum D5). Pure.
 *
 * One line, directly under the situation, that answers "what is left before
 * this mission is delivered": Integrated → Verified → Shipped → Budget. It
 * replaces the progress card, the mission PR card, the release card, the two
 * budget cards and the four completion stat tiles, each of which used to be its
 * own block between the outcome and the task list. A step with nothing to say
 * is hidden, never rendered empty.
 */
import { deriveMissionProgressSubline, type MissionIntegrationPrView } from './mission-integration-pr';
import type { ReleaseState } from './release-state';

export type DeliveryStepKey = 'integrated' | 'verified' | 'shipped' | 'budget';
export type DeliveryStepState = 'done' | 'partial' | 'todo' | 'blocked';

export const DELIVERY_STATE_GLYPH: Record<DeliveryStepState, string> = {
  done: '●',
  partial: '◐',
  todo: '○',
  blocked: '✕',
};

export const DELIVERY_STEP_LABEL: Record<DeliveryStepKey, string> = {
  integrated: 'Integrated',
  verified: 'Verified',
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

/** `Integrated ◐ 4/6 · Verified ◐ 2/3 · Shipped ○ –` */
export function formatDeliverySummary(steps: readonly DeliveryStep[]): string {
  return steps.map(s => `${s.label} ${DELIVERY_STATE_GLYPH[s.state]} ${s.value}`).join(' · ');
}
