/**
 * The `?state=visual-review` dev fixture: the visual review component family
 * (components/visual-review/, docs/design/visual-qa-human-review.md) over
 * the fixture models in lib/visual-review-model.fixtures.ts.
 *
 *   ?state=visual-review&phase=<phase>        Line + Ask + Tray for a phase
 *   &reason=question|unsure|round_cap         which needs_you
 *   &view=board                               embedded like the mission board
 *   &view=deck | deck-phone | compare         the review deck (dialog, inline sheet, compare open)
 *   &view=fix-check                           a merged fix with a new screenshot: Before / After, Fixed / Still broken
 *   &view=fix-merged                          a merged fix with no screenshot since: settled, no buttons
 *   &view=reviewed                            the reviewed tray
 *   &expired=1                                one image that fails to load
 *
 * Illustrative fixtures only: SVG sketches, never captures (the repo is
 * public). Decisions go to an in-memory transport, never the network.
 */
import { VISUAL_REVIEW_PHASES, type VisualReviewNeedsYouReason, type VisualReviewPhase } from '@buildd/shared';
import type { VisualReviewFixtureOptions } from '@/lib/visual-review-model.fixtures';
import { mockWorkers } from './fixtures-data';

export const VISUAL_REVIEW_FIXTURE_STATE = 'visual-review';
/** The real mission Board, Lanes and Feed with a visual model (mission-board-visual-fixtures.ts). */
export const MISSION_BOARD_VISUAL_FIXTURE_STATE = 'mission-board-visual';

/** Every `?state=` the fixtures page understands. */
/** The missions-list cards under each executor (mission-list-executor-fixtures.ts). */
export const MISSION_LIST_EXECUTOR_FIXTURE_STATE = 'mission-list-executor';
/** The mission Settings sheet's check-ins and organizer runs (MissionCheckInsFixture.tsx). */
export const MISSION_CHECK_INS_FIXTURE_STATE = 'mission-check-ins';
/** The task page's Evidence files section in each state (TaskEvidenceFilesFixture.tsx). */
export const TASK_EVIDENCE_FIXTURE_STATE = 'task-evidence';
/** The mission's Goal criteria sheet: not-verifiable and ready states (GoalCriteriaFixture.tsx). */
export const GOAL_CRITERIA_FIXTURE_STATE = 'goal-criteria';

/** The workspace onboarding card with a stubbed readiness report (OnboardingFixture.tsx). */
export const ONBOARDING_FIXTURE_STATE = 'onboarding';

/** Settings → Storage with fixture backends (EvidenceStorageFixture.tsx). */
export const EVIDENCE_STORAGE_FIXTURE_STATE = 'evidence-storage';

/** Team settings → Platform Operator access, team ceiling + per-workspace grants (OperatorAccessFixture.tsx). */
export const OPERATOR_ACCESS_FIXTURE_STATE = 'operator-access';
/** Settings → Model providers with a gateway, a team agent endpoint and two overrides (ModelProvidersFixture.tsx). */
export const MODEL_PROVIDERS_FIXTURE_STATE = 'model-providers';

/** The completed task page's What shipped header, and Checks by commit (task-shipped-fixtures.ts). */
export const TASK_SHIPPED_FIXTURE_STATE = 'task-shipped';
export const COMMIT_CHECKS_FIXTURE_STATE = 'commit-checks';

/** A question's answer pending, recorded, already answered and failed (AnswerStatesFixture.tsx). */
export const ANSWER_STATES_FIXTURE_STATE = 'answer-states';
export const AGENT_ACCESS_FIXTURE_STATE = 'agent-access';
/** A queued task held on a managed-runner plan limit (EntitlementBlockedFixture). */
export const ENTITLEMENT_BLOCKED_FIXTURE_STATE = 'entitlement-blocked';
/** A worker failure beside a landed-work, failed-audit one (FailureKindsFixture.tsx). */
export const FAILURE_KINDS_FIXTURE_STATE = 'failure-kinds';

/** Health's tool list with every row's breakdown, collapsed and open (tool-breakdown-fixture.tsx). */
export const TOOL_BREAKDOWN_FIXTURE_STATE = 'tool-breakdown';

/** The mission Board's Landed strip and its tethered drawer (mission-task-strip-fixtures.ts). */
export const MISSION_TASK_STRIP_FIXTURE_STATE = 'mission-task-strip';

/** Workspace settings' Cloud runner size section, derived / explicit / default (RunnerSizeFixture.tsx). */
export const RUNNER_SIZE_FIXTURE_STATE = 'runner-size';
/** The mission page's "Waive visual audit": the blocked audit's drawer and the Visual review card. */
export const SURFACE_AUDIT_WAIVER_FIXTURE_STATE = 'surface-audit-waiver';
/** The hosted runner allowance on every surface it shows (HostedRunnerFixture.tsx). */
export const HOSTED_RUNNER_FIXTURE_STATE = 'hosted-runner';
/** Activity's Interactive sessions section, one session per state (InteractiveSessionsFixture.tsx). */
export const INTERACTIVE_SESSIONS_FIXTURE_STATE = 'interactive-sessions';

/** Settings → Workspaces list: differs chips, team groups, inactive fold (WorkspacesListFixture.tsx). */
export const WORKSPACES_LIST_FIXTURE_STATE = 'workspaces-list';

/** Kernel-owned deliveries on Home and the task page (DeliveryStatesFixture.tsx). */
export const DELIVERY_STATES_FIXTURE_STATE = 'delivery-states';
/** The next moves those deliveries offer, opened (DeliveryActionsFixture.tsx). */
export const DELIVERY_REVIEW_ACTIONS_FIXTURE_STATE = 'delivery-review-actions';
export const DELIVERY_DOCK_FIXTURE_STATE = 'delivery-dock';
export const DELIVERY_RUN_FIX_FIXTURE_STATE = 'delivery-run-fix';
/** Activity Now/History, with one delivery walked through audit fail → repair → land (ActivityDeliveryFixture.tsx). */
export const ACTIVITY_DELIVERY_FIXTURE_STATE = 'activity-delivery';

/** The team page's members, owner + admin + member, seen as each (team-members-fixtures.ts). */
export const TEAM_MEMBERS_FIXTURE_STATE = 'team-members';

export const FIXTURE_VIEWS: readonly string[] = [...Object.keys(mockWorkers), VISUAL_REVIEW_FIXTURE_STATE, MISSION_BOARD_VISUAL_FIXTURE_STATE, MISSION_LIST_EXECUTOR_FIXTURE_STATE, MISSION_CHECK_INS_FIXTURE_STATE, GOAL_CRITERIA_FIXTURE_STATE, TASK_EVIDENCE_FIXTURE_STATE, EVIDENCE_STORAGE_FIXTURE_STATE, MODEL_PROVIDERS_FIXTURE_STATE, OPERATOR_ACCESS_FIXTURE_STATE, TASK_SHIPPED_FIXTURE_STATE, COMMIT_CHECKS_FIXTURE_STATE, ANSWER_STATES_FIXTURE_STATE, AGENT_ACCESS_FIXTURE_STATE, FAILURE_KINDS_FIXTURE_STATE, ENTITLEMENT_BLOCKED_FIXTURE_STATE, ONBOARDING_FIXTURE_STATE, MISSION_TASK_STRIP_FIXTURE_STATE, TOOL_BREAKDOWN_FIXTURE_STATE, RUNNER_SIZE_FIXTURE_STATE, INTERACTIVE_SESSIONS_FIXTURE_STATE, WORKSPACES_LIST_FIXTURE_STATE, HOSTED_RUNNER_FIXTURE_STATE, DELIVERY_STATES_FIXTURE_STATE, SURFACE_AUDIT_WAIVER_FIXTURE_STATE, DELIVERY_REVIEW_ACTIONS_FIXTURE_STATE, DELIVERY_DOCK_FIXTURE_STATE, DELIVERY_RUN_FIX_FIXTURE_STATE, ACTIVITY_DELIVERY_FIXTURE_STATE, TEAM_MEMBERS_FIXTURE_STATE];

export function isFixtureView(value: string | null | undefined): value is string {
  return value != null && FIXTURE_VIEWS.includes(value);
}

export const VISUAL_REVIEW_FIXTURE_VIEWS = ['tray', 'board', 'deck', 'deck-phone', 'compare', 'fix-check', 'fix-merged', 'reviewed'] as const;
export type VisualReviewFixtureView = (typeof VISUAL_REVIEW_FIXTURE_VIEWS)[number];

const REASONS: readonly VisualReviewNeedsYouReason[] = ['unsure', 'question', 'round_cap'];

export interface VisualReviewFixtureParams {
  view: VisualReviewFixtureView;
  phase: VisualReviewPhase;
  options: VisualReviewFixtureOptions;
  /** The deck opens on this cell. */
  startKey: string | null;
  compare: boolean;
}

/** The compare view opens on the route the second round re-shot. */
export const COMPARE_START_KEY = '/app/tasks/:id|mobile|';
/** Its fix merged and round 2 re-shot it: a fix check. */
export const FIX_CHECK_START_KEY = COMPARE_START_KEY;
/** Its fix merged after the last screenshot: settled. */
export const FIX_MERGED_START_KEY = '/app/inbox|mobile|';

/** Pure: `?view=&phase=&reason=&expired=` to what the page renders. Unknown values fall back. */
export function parseVisualReviewFixtureParams(q: URLSearchParams): VisualReviewFixtureParams {
  const viewParam = q.get('view');
  const view: VisualReviewFixtureView = (VISUAL_REVIEW_FIXTURE_VIEWS as readonly string[]).includes(viewParam ?? '')
    ? (viewParam as VisualReviewFixtureView)
    : 'tray';
  const phaseParam = q.get('phase');
  const reasonParam = q.get('reason');
  const reason = (REASONS as readonly string[]).includes(reasonParam ?? '') ? (reasonParam as VisualReviewNeedsYouReason) : undefined;
  const expired = q.get('expired') === '1';
  const deckLike = view === 'deck' || view === 'deck-phone' || view === 'compare' || view === 'fix-check' || view === 'fix-merged';

  if (view === 'reviewed') {
    return { view, phase: 'reviewed', options: { expired }, startKey: null, compare: false };
  }
  if (deckLike) {
    // The two-round working set with mixed human reviews.
    return {
      view,
      phase: 'needs_you',
      options: { needsYou: 'unsure', scenario: 'deck', expired },
      startKey: view === 'compare' ? COMPARE_START_KEY : view === 'fix-check' ? FIX_CHECK_START_KEY : view === 'fix-merged' ? FIX_MERGED_START_KEY : null,
      compare: view === 'compare',
    };
  }
  const phase = (VISUAL_REVIEW_PHASES as readonly string[]).includes(phaseParam ?? '') ? (phaseParam as VisualReviewPhase) : 'needs_you';
  const options: VisualReviewFixtureOptions = { expired };
  if (phase === 'needs_you') {
    options.needsYou = reason ?? 'unsure';
    if (options.needsYou === 'unsure') options.scenario = 'deck';
  }
  return { view, phase, options, startKey: null, compare: false };
}

/** The fixture links the page shows: every phase, then the deck and board views. */
export function visualReviewFixtureLinks(): { label: string; href: string }[] {
  const base = `?state=${VISUAL_REVIEW_FIXTURE_STATE}`;
  return [
    ...VISUAL_REVIEW_PHASES.filter(p => p !== 'needs_you').map(p => ({ label: p, href: `${base}&phase=${p}` })),
    ...REASONS.map(r => ({ label: `needs_you: ${r}`, href: `${base}&phase=needs_you&reason=${r}` })),
    { label: 'board', href: `${base}&view=board` },
    { label: 'deck', href: `${base}&view=deck` },
    { label: 'deck-phone', href: `${base}&view=deck-phone` },
    { label: 'compare', href: `${base}&view=compare` },
    { label: 'fix merged, new screenshot', href: `${base}&view=fix-check` },
    { label: 'fix merged, no screenshot yet', href: `${base}&view=fix-merged` },
    { label: 'reviewed', href: `${base}&view=reviewed` },
    { label: 'expired', href: `${base}&view=deck-phone&expired=1` },
  ];
}
