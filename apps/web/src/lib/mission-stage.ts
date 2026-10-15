// @ui-copy: strings here render in buildd top; copy:check and the em-dash test scan them.
/**
 * A mission's stage for a list (`GET /api/missions/stages`, which the runner
 * puts on its task list as `mission.stage`, read by
 * `buildd top`, spec c7410e76 R-18): the current step of the mission page's
 * Build / Verify / Deliver rail and what it waits on, in the rail's own words.
 *
 * It runs the rail's own projection (`missionChecks`, lib/mission-checks.ts),
 * so the two never disagree on the rules. What differs is the inputs: the
 * mission page loads per-mission state a list cannot afford for every mission
 * on every poll (the visual review state, the release deploy baseline). This
 * reads only what one batched query per table gives, and where it cannot know
 * something it says less, never more:
 *   - no visual review state: a clean pass is the audit's shots, verdicts,
 *     human reviews and fix rounds, about a dozen reads per mission on the
 *     page. A list cannot tell a pass from findings by the task alone, so any
 *     visual verification task (not cancelled) keeps an unfinished mission
 *     verifying, worded from its newest audit; only a completed mission is
 *     delivered past one;
 *   - no deploy baseline: a configured release reads `waiting` or `started`
 *     (dispatched), never `healthy`, so only a completed mission is delivered
 *     past a release.
 */
import type { GoalCriteriaState, GoalCriterion, MissionStage, MissionStageStep } from '@buildd/shared';
import { deliverableRole, isBuildDeliverable, isDeliverableTask } from '@buildd/core/mission-helpers';
import { missionChecks, type MergeTier, type RailKey } from './mission-checks';
import { deriveMissionIntegrationPr } from './mission-integration-pr';
import type { MissionReleaseStatus } from './mission-delivery';
import { missionTrunkMergedAt } from './mission-delivery';

export interface MissionStagePr {
  prUrl: string | null;
  prNumber: number | null;
  mergedAt: string | Date | null;
  prLifecycleStatus: string | null;
}

export interface MissionStageTask {
  id: string;
  title: string | null;
  status: string;
  taskClass: string | null;
  kind: string | null;
  mode: string | null;
  category: string | null;
  roleSlug: string | null;
  context: unknown;
  /** Orders the visual audits: the newest one words the wait. */
  createdAt?: string | Date | null;
  /** The task's workers that carry a PR. */
  prs: MissionStagePr[];
}

export interface MissionStageInput {
  mission: {
    status: string;
    isHeld: boolean;
    integrationBranchEnabled: boolean;
    workingBranch: string | null;
    goalCriteria: GoalCriterion[] | null;
    goalCriteriaState: GoalCriteriaState | null;
    releasedAt: string | Date | null;
  };
  tasks: MissionStageTask[];
  /** The trunk the mission delivers into. */
  target: string | null;
  mergeTier: MergeTier;
  /** The workspace has a release pipeline (`detectArchetype` is not `none`). */
  releaseConfigured: boolean;
}

const STEP: Record<RailKey, MissionStageStep> = { build: 'building', verify: 'verifying', deliver: 'delivering' };

const ms = (d: string | Date) => (typeof d === 'string' ? Date.parse(d) : d.getTime());

/** Landed: finished, and its PR (when it has one) merged. */
function landed(t: MissionStageTask): boolean {
  return t.status === 'completed' && (t.prs.length === 0 || t.prs.some(p => p.mergedAt));
}

/** The release without a deploy baseline: never `healthy`, so nothing passes on a guess. */
function releaseWithoutBaseline(configured: boolean, merges: string[], releasedAt: string | Date | null): MissionReleaseStatus {
  if (!configured) return 'not_configured';
  const times = merges.map(ms).filter(t => !Number.isNaN(t));
  if (times.length === 0 || !releasedAt) return 'waiting';
  return ms(releasedAt) >= Math.max(...times) ? 'dispatched' : 'waiting';
}

/** The newest visual verification task that is not cancelled, if any. */
function latestAudit(tasks: MissionStageTask[]): MissionStageTask | null {
  let best: MissionStageTask | null = null;
  for (const t of tasks) {
    if (t.status === 'cancelled' || !isDeliverableTask(t) || deliverableRole(t) !== 'verification') continue;
    if (!best || (t.createdAt != null && (best.createdAt == null || ms(t.createdAt) > ms(best.createdAt)))) best = t;
  }
  return best;
}

/**
 * The visual review row's words (`visualCheck`) for what the task alone shows.
 * A completed audit is a pass or findings, which only the page can tell.
 */
function auditWaitingOn(status: string): string {
  if (status === 'pending') return 'queued';
  if (status === 'failed') return 'unable to run';
  if (status === 'waiting_input') return 'a question for you';
  if (status === 'completed') return 'see the mission page';
  return 'checking';
}

export function missionStage(input: MissionStageInput): MissionStage {
  const { mission } = input;
  if (mission.status === 'completed') return { step: 'delivered', waitingOn: null };
  if (mission.isHeld || mission.status === 'paused') return { step: 'on_hold', waitingOn: null };

  const build = input.tasks.filter(t => t.status !== 'cancelled' && isBuildDeliverable(t));
  if (build.length === 0) return { step: 'planning', waitingOn: null };

  const withWorkers = input.tasks.map(t => ({ ...t, workers: t.prs }));
  const integrationPr = deriveMissionIntegrationPr({ mission, tasks: withWorkers });
  const merges = missionTrunkMergedAt(withWorkers, integrationPr);
  const checks = missionChecks({
    build: { done: build.filter(landed).length, total: build.length },
    branch: mission.integrationBranchEnabled ? 'mission-branch' : 'direct',
    target: input.target,
    mergeTier: input.mergeTier,
    visual: null,
    criteria: mission.goalCriteria ?? [],
    criteriaState: mission.goalCriteriaState,
    integrationPr,
    release: releaseWithoutBaseline(input.releaseConfigured, merges, mission.releasedAt),
  });

  if (checks.checkpoint === 'build') return { step: 'building', waitingOn: checks.rail[0].text };
  // The page reads the visual review state; a list sees only the audit tasks,
  // and a completed audit may hold findings. So an audit keeps the mission
  // verifying until the mission itself completes, whatever the rest says.
  const audit = latestAudit(input.tasks);
  if (audit) return { step: 'verifying', waitingOn: auditWaitingOn(audit.status) };
  if (checks.checkpoint === 'done') return { step: 'delivered', waitingOn: null };
  const step = checks.rail.find(s => s.key === checks.checkpoint)!;
  return { step: STEP[checks.checkpoint], waitingOn: step.text };
}
