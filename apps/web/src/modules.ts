import type { RunProgressReaders } from '@/lib/run-progress-read';
import { readPrReviewStatus } from '@/lib/pr-review-request';
import { resolvePolicy } from '@/lib/merge-policy';
import MyMaximumSection from '@/app/app/(protected)/settings/models/MyMaximumSection';
import { isPlatformOperatorCaller, operatorOnlyResponse } from '@/lib/admin/platform-operator-caller';
/**
 * Composition root: the one place optional modules are wired into core.
 *
 * Core code never imports a module (scripts/module-boundaries.test.ts). It
 * emits core events (lib/core-events.ts, lib/core-emit.ts) and this list says
 * who reacts. It is code, not configuration: no env var turns a module on or
 * off. A deployment that does not use a module runs the same build with that
 * module's tables empty, and its subscribers are no-ops.
 *
 * Order is load-bearing within an event type: subscribers run in list order.
 * `modules.test.ts` pins the order per event.
 */
import type { AnySubscriber } from '@/lib/core-events';
import { decisionSubscribers } from '@/lib/decision-subscribers';
import { startDecisionReplayStore } from '@/lib/decision-replay-store';
import { loadIncidentNeedsYou, loadIncidentVerdicts } from '@/lib/failure-incident-escalation';
import { loadDecisionCollectionNeedsYou } from '@/lib/decision-collection-needs-you';
import { loadAccessNeedsYou } from '@/lib/capability-grants-needs-you';
import { loadDecisionHealthNeedsYou } from '@/lib/decision-health-needs-you';
import { probeDecisionModel } from '@buildd/core/decision-probe';
import type { CompletionPolicies } from '@/lib/completion-policy';
import { visualAuditEvidencePolicy } from '@/lib/visual-audit-evidence-policy';
import { loopPolicy } from '@/lib/loop-dispatcher-policy';
import { releasePolicy } from '@/lib/release-completion-policy';
import { knowledgeSubscribers } from '@/lib/knowledge-subscribers';
import { missionSubscribers } from '@/lib/mission-subscribers';
import { reviewSubscribers } from '@/lib/review-subscribers';
import { reviewerSubscribers, reviewerDispatchOnOpen } from '@/lib/reviewer-subscribers';
import { specCheckSubscribers } from '@/lib/spec-check-subscribers';
import type { PrOpenedPolicy } from '@/lib/pr-opened-policy';
import type { ApprovedMergeRule } from '@/lib/workflow/delivery-view';
import { approvedNeedsPerson } from '@/lib/merge-policy-approved';
import type { EffectHandlers } from '@/lib/workflow/effects';
import { reviewEffectHandlers } from '@/lib/workflow/review-effects';
import { withCiRetryEffects } from '@/lib/workflow/ci-retry-effects';
import { withTrunkEffects } from '@/lib/workflow/ci-red-trunk-effects';
import { withConflictEffects } from '@/lib/workflow/conflict-retry-effects';
import { withLandingEffects } from '@/lib/workflow/pr-landing-effects';
import { withSupersessionEffects } from '@/lib/workflow/supersession-effects';
import type { LegacyFirstReview } from '@/lib/workflow/legacy-handoff';
import { legacyFirstReview } from '@/lib/workflow/review-handoff';
import type { QuestionCheckDeps } from '@/lib/question-gate-check';
import { fileRecoverableBlockerRepair } from '@/lib/recoverable-blocker-repair';
import { escalationGateDeps, escalationGateReadDeps } from '@/lib/escalation-decision';
import { releaseSubscribers } from '@/lib/release/subscribers';
import { earlyReleaseSubscribers } from '@/lib/early-release-subscribers';
import { chatSubscribers } from '@/lib/chat/subscribers';
import { notificationSubscribers } from '@/lib/notification-subscribers';
import { roleSubscribers } from '@/lib/default-roles-subscribers';
import { connectorCatalogSubscribers } from '@/lib/connector-catalog-subscribers';
import { routingAnalyticsSubscribers } from '@/lib/routing-analytics-subscribers';
import { verdictSubscribers } from '@/lib/verdict-decision-subscribers';
import { surfaceAuditSubscribers } from '@/lib/surface-audit-subscribers';
import { taskEstimateExperimentSubscribers } from '@/lib/task-estimate-experiment-subscribers';
import { failurePatternSubscribers } from '@/lib/failure-pattern-subscribers';
import { overrideStartSubscribers } from '@/lib/override-start-decision';
import { answerInChatHref } from '@/lib/chat/answer-link';
import { loadPrActionSheet } from '@/lib/pr-landing-sheet';
import type { ClaimContextInjection } from '@/app/api/workers/claim/context-injection';
import { attachVisualAuditRoutes } from '@/app/api/workers/claim/visual-audit-routes';
import { attachVisualAuditSpecCriteria } from '@/app/api/workers/claim/visual-audit-spec-criteria';
import { recordVisualVerdict } from '@/lib/visual-audit-spec-verdict';
import { checkSpecDuplicates, recordDuplicateOverride } from '@/lib/spec-duplicate-decision';

export const SUBSCRIBERS: readonly AnySubscriber[] = [
  // task.created: the category look is scheduled before the mission chain starts.
  ...decisionSubscribers,
  ...knowledgeSubscribers,
  ...missionSubscribers,
  // pr.closed: the surface settle is scheduled before the review reactions.
  ...reviewSubscribers,
  // pr.merged: the release record is kicked off before the ledger write.
  ...releaseSubscribers,
  ...earlyReleaseSubscribers,
  // Before notifications: on a completion the chat post was kicked off first.
  ...chatSubscribers,
  ...notificationSubscribers,
  // pr.ci_failed: the ledger records the red head before the CI-fix retry is asked.
  ...reviewerSubscribers,
  // A PR head: spec criterion checks for it, after the reviewer reacts to the push.
  ...specCheckSubscribers,
  ...roleSubscribers,
  ...connectorCatalogSubscribers,
  // A held release's outcome-analytics row, recorded when its CI resolves it.
  ...routingAnalyticsSubscribers,
  // task.left_mission: the surface audit lets go of a task that left its mission.
  ...surfaceAuditSubscribers,
  // task.completed / task.pr_merged: a task's actuals, stored next to its frozen estimate.
  ...taskEstimateExperimentSubscribers,
  // task.terminal: the failure-pattern sweep for the workspace, after the evidence record is written.
  ...failurePatternSubscribers,
  // task.override_started: the graded decision row for a forced start.
  ...overrideStartSubscribers,
  // Last: the verdict recompute reads the evidence record the knowledge
  // module wrote and the CI/PR state the reviews module settled.
  ...verdictSubscribers,
];

/**
 * Completion policies, one per core-declared slot (lib/completion-policy.ts).
 * Not subscribers: each returns a verdict the worker PATCH applies, so the
 * PATCH stays the one place a task's terminal status is decided. The slot
 * order (evidence, loop, release) is core's, not this object's.
 */
export const COMPLETION_POLICIES: CompletionPolicies = {
  evidence: visualAuditEvidencePolicy,
  loop: loopPolicy,
  release: releasePolicy,
};

/**
 * The PR-opened slot (lib/pr-opened-policy.ts): the reviews module may take a
 * freshly opened worker PR, and a PR it holds skips core's no-CI auto-merge.
 */
export const PR_OPENED_POLICY: PrOpenedPolicy = reviewerDispatchOnOpen;

/**
 * The kill-switch hand-off slot (lib/workflow/legacy-handoff.ts): a delivery
 * the switch released before its first kernel round gets legacy's first
 * review from the reviews module, so the PR is never left with no reviewer.
 */
export const LEGACY_FIRST_REVIEW: LegacyFirstReview = legacyFirstReview;

/** Review-backed read hooks for core's run-progress projection. */
export const RUN_PROGRESS_READERS: RunProgressReaders = {
  review: readPrReviewStatus,
  usesReviewer: (...args) => resolvePolicy(...args).tier === 'agent-review',
};
/**
 * The approved-merge slot (lib/workflow/delivery-view.ts): the reviews
 * module's merge policy says whether an APPROVED delivery waits on a person
 * (needs you) or the landing path merges it (merging).
 */
export const APPROVED_MERGE_RULE: ApprovedMergeRule = approvedNeedsPerson;

/**
 * The workflow kernel's effect handlers (lib/workflow/effects.ts). The kernel
 * (core) decides and records the effect; the reviews module carries out the
 * review-loop ones (reviewer and fix tasks, GitHub reviews, escalations), the
 * CI family's (CI fix tasks bound to their ledger row, CI exhaustion), the
 * conflict/migration families' (mechanical refresh and renumber first, an
 * agent conflict fix only on a refusal, conflict exhaustion), the trunk
 * breaker's (one trunk-fix task per incident, cancelling the per-PR CI fix
 * tasks a trunk incident skipped), landing and
 * post-merge work (merge call, verify, post-merge events, mission-PR
 * finalize), and a closed PR's resolution (supersession scan, the edge's
 * projection, mission wake). Each effect kind has exactly one handler.
 *
 * Built on first use, not at load: the handler modules reach back into this
 * file through core-emit (post-merge work emits events), so composing them at
 * load time works or throws depending on which module a process imports first.
 */
let workflowEffectHandlersMemo: EffectHandlers | null = null;
export function workflowEffectHandlers(): EffectHandlers {
  return (workflowEffectHandlersMemo ??= withSupersessionEffects(withLandingEffects(withTrunkEffects(withConflictEffects(withCiRetryEffects(reviewEffectHandlers))))));
}

/**
 * The question gate's recover slot (lib/question-gate-check.ts): a recoverable
 * blocker an agent tried to ask about is filed as a repair task instead.
 */
export const RECOVERABLE_BLOCKER_REPAIR: NonNullable<QuestionCheckDeps['fileRepair']> = fileRecoverableBlockerRepair;

/**
 * The escalation gate's slots (lib/escalation-gate-check.ts): Jev, the ledger
 * and the repair filer, for a core caller such as Home that gates PRs.
 */
export const ESCALATION_GATE_DEPS = escalationGateDeps;
/** What a page passes: stored verdicts and rules, the rest looked at after the response. */
export const ESCALATION_GATE_READ_DEPS = escalationGateReadDeps;

/**
 * The Failure Pattern Sentinel's slots for core pages (lib/failure-incident-escalation.ts):
 * Home's Needs You rows for incidents the escalation gate gave to the owner, and the
 * stored verdict the incident page shows. Both read the ledger; neither calls a model.
 */
export const INCIDENT_NEEDS_YOU = loadIncidentNeedsYou;
export const INCIDENT_VERDICTS = loadIncidentVerdicts;

/**
 * The decision ledger's slot for Home (lib/decision-collection-needs-you.ts):
 * decision features asked all day that never got a model answer, for the
 * platform operator. Reads the ledger; no model call.
 */
export const DECISION_COLLECTION_NEEDS_YOU = loadDecisionCollectionNeedsYou;

/**
 * The connectors module's slot for Home (lib/capability-grants-needs-you.ts):
 * pending capability requests the escalation gate gives to a person, for the
 * teams where the viewer can decide them. A fixed rule; no model call.
 */
export const ACCESS_NEEDS_YOU = loadAccessNeedsYou;

/**
 * The decisions module's slot for Home (lib/decision-health-needs-you.ts): one
 * card per team whose decision calls nearly all fail at the provider, for the
 * people who can change the decision model. Reads the ledgers; no model call.
 */
export const DECISION_HEALTH_NEEDS_YOU = loadDecisionHealthNeedsYou;

/**
 * The decisions module's slot for the team settings route
 * (packages/core/decision-probe.ts): one test decision through a decision
 * model's exact route before it is saved.
 */
export const DECISION_MODEL_PROBE = probeDecisionModel;

/**
 * The decisions module's slot for Home (lib/decision-health-needs-you.ts): one
 * card per team whose decision calls nearly all fail at the provider, for the
 * people who can change the decision model. Reads the ledgers; no model call.
 */
export const DECISION_HEALTH_NEEDS_YOU = loadDecisionHealthNeedsYou;

/**
 * The decisions module's slot for the team settings route
 * (packages/core/decision-probe.ts): one test decision through a decision
 * model's exact route before it is saved.
 */
export const DECISION_MODEL_PROBE = probeDecisionModel;

/**
 * The chat module's slot for the task page (lib/chat/answer-link.ts): where an
 * answer link (`?respond=1`) goes when the question folds into the reader's own
 * conversation. Null keeps them on the task page's reply box.
 */
export const ANSWER_IN_CHAT = answerInChatHref;

/**
 * The reviews module's slot for Home (lib/pr-landing-sheet.ts): what the PR
 * action sheet (`?pr=<n>&t=<token>`, a landing alert's link) shows, as data.
 */
export const PR_ACTION_SHEET = loadPrActionSheet;

/**
 * The model-tiers module's slot for Settings › You › Keys: a member's own
 * maximum tier (`member_self`, docs/specs/model-tier-ceilings.md). A client
 * component; the Keys page renders it.
 */
export const MY_MAXIMUM_SECTION = MyMaximumSection;

/**
 * The platform operator check (lib/admin/platform-operator-caller.ts) for core
 * team routes that hold an operator-only field: `decisionModel` on PATCH
 * /api/teams/[id], `overCapAuto` on the model ceilings. One definition; core
 * reaches it here rather than importing the admin module.
 */
export const IS_PLATFORM_OPERATOR_CALLER = isPlatformOperatorCaller;
export const OPERATOR_ONLY_RESPONSE = operatorOnlyResponse;

/**
 * The visual-qa module's claim slot (app/api/workers/claim/visual-audit-routes.ts):
 * a surface audit's prompt states the required routes completion will check,
 * computed at claim from its current dependencies, and the Living Spec
 * criteria of the tasks it depends on (visual-audit-spec-criteria.ts).
 */
export const VISUAL_AUDIT_ROUTES: ClaimContextInjection = async (claimedWorkers, claimedTasks) => {
  await attachVisualAuditRoutes(claimedWorkers, claimedTasks);
  await attachVisualAuditSpecCriteria(claimedWorkers, claimedTasks);
};

/**
 * The visual-qa module's spec verdict slot (lib/visual-audit-spec-verdict.ts):
 * POST /api/specs/outcomes/[taskId] with `checker: 'visual'` records what a
 * mission's [surface audit] saw on a spec criterion.
 */
export const VISUAL_SPEC_VERDICT = recordVisualVerdict;

/**
 * The decisions module's spec duplicate slot (lib/spec-duplicate-decision.ts):
 * createSpecDraft compares a new spec with the approved ones, and records a
 * person's override of a refusal on the ledger rows that refused it.
 */
export const SPEC_DUPLICATE_CHECK = checkSpecDuplicates;
export const SPEC_DUPLICATE_OVERRIDE = recordDuplicateOverride;

/**
 * The knowledge module's boot slot for Living Spec neighbours (instrumentation.ts):
 * installs the spec-corpus similarity query behind core's `neighbourDeps`
 * (lib/specs/neighbours.ts), so the nearby route can suggest a parent.
 */
export const SPEC_SIMILARITY = async (): Promise<void> => {
  const { installSpecSimilarity } = await import('@/lib/specs/knowledge');
  installSpecSimilarity();
};

/**
 * The decisions module's boot slot (instrumentation.ts): installs the evidence
 * backend store behind `@buildd/core/decision-replay`, so each decision keeps
 * a replayable copy of its input. Without it capture is a no-op.
 */
export const DECISION_REPLAY_STORE = startDecisionReplayStore;
