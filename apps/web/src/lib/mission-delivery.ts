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
   * The workspace release ledger, classified (`classifyReleaseState`). `null`
   * when the workspace has no release flow (`none` archetype). `visible` means
   * merged work is waiting for the next release.
   */
  release: { visible: boolean } | null;
  budget: { budgetUsd: number; spendUsd: number | null; exhausted: boolean } | null;
  /** Completion stats, carried on the Integrated detail instead of stat tiles. */
  prCount?: number;
  durationLabel?: string | null;
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

  // D6: the workspace queue depth is a workspace fact. The mission's step says
  // only where its own work stands; the count stays on the release surface.
  if (input.release) {
    if (input.release.visible) {
      steps.push({ key: 'shipped', label: DELIVERY_STEP_LABEL.shipped, state: 'todo', value: '–', detail: 'after next release' });
    } else if (completedTasks > 0) {
      steps.push(workLanded
        ? { key: 'shipped', label: DELIVERY_STEP_LABEL.shipped, state: 'done', value: '✓', detail: 'released' }
        : { key: 'shipped', label: DELIVERY_STEP_LABEL.shipped, state: 'partial', value: '–', detail: 'landed work is released; the rest ships after it merges' });
    }
  }

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
 * The workspace release ledger (`classifyReleaseState`), as far as a mission's
 * Shipped step may read it. Only two answers are claims: a gated queue holding
 * merged work (waiting for the next release) and a clean queue or a healthy
 * continuous deploy (released). Everything else — no flow, no baseline, a
 * deploy in flight or failing — claims nothing and hides the step.
 */
export function deliveryReleaseInput(state: ReleaseState): DeliveryInput['release'] {
  if (state.state === 'unseeded') {
    if (state.archetype === 'gated') return { visible: true };
    return state.deployState === 'healthy' ? { visible: false } : null;
  }
  if (state.state === 'clean' && state.reason === 'zero_queue') return { visible: false };
  return null;
}

/** `Integrated ◐ 4/6 · Verified ◐ 2/3 · Shipped ○ –` */
export function formatDeliverySummary(steps: readonly DeliveryStep[]): string {
  return steps.map(s => `${s.label} ${DELIVERY_STATE_GLYPH[s.state]} ${s.value}`).join(' · ');
}
