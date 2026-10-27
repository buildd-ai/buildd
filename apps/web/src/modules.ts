import { claimAreaClass } from '@buildd/core/orchestration-claim-learning-evidence';
import { CLAIM_HOLD_DECISION } from '@buildd/core/orchestration-claim-decision';
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
import { accessNeedsYouRead } from '@/lib/capability-grants-needs-you';
import { homeMissionSummaries } from '@/lib/mission-summary-home';
import { loadMissionStagesFromSummaries } from '@/lib/mission-stage-read';
import { MAX_STAGE_MISSION_IDS } from '@/lib/mission-stage';
import { probeDecisionModel } from '@buildd/core/decision-probe';
import type { CompletionPolicies } from '@/lib/completion-policy';
import { visualAuditEvidencePolicy } from '@/lib/visual-audit-evidence-policy';
import { loopPolicy } from '@/lib/loop-dispatcher-policy';
import { releasePolicy } from '@/lib/release-completion-policy';
import { knowledgeSubscribers } from '@/lib/knowledge-subscribers';
import { missionSubscribers } from '@/lib/mission-subscribers';
import { refreshMissionSummariesFor } from '@/lib/mission-summary-store';
import type { WorkChangeListener } from '@/lib/work-changed';
import { reviewSubscribers } from '@/lib/review-subscribers';
import { reviewerSubscribers, reviewerDispatchOnOpen } from '@/lib/reviewer-subscribers';
import { specCheckSubscribers } from '@/lib/spec-check-subscribers';
import type { PrOpenedPolicy } from '@/lib/pr-opened-policy';
import type { ApprovedMergeRule } from '@/lib/workflow/delivery-view';
import { approvedNeedsPerson } from '@/lib/merge-policy-approved';
import type { BuilddKernelHooks } from '@/lib/workflow/kernel-ports';
import type { Escalate } from '@buildd/workflow-kernel/ports';
import { fixWork, captureWork, reviewEscalate, reviewsHost, reviewWork } from '@/lib/workflow/review-effects';
import { ciEscalate, ciEvidence, ciFixWork } from '@/lib/workflow/ci-retry-effects';
import { externalMergeFixWork, trunkFixWork } from '@/lib/workflow/ci-red-trunk-effects';
import { guardMissionPrMerge } from '@/lib/mission-pr';
import { builddLandingRails } from '@/lib/workflow/auto-merge-rails';
import { conflictEscalate, conflictFixWork, conflictsHost } from '@/lib/workflow/conflict-retry-effects';
import { builddDecide } from '@/lib/workflow/decision-port';
import { landingLifecycle, mergeAnswerOf } from '@/lib/workflow/pr-landing-effects';
import { supersessionLifecycle } from '@/lib/workflow/supersession-effects';
import { notifyTeamOf } from '@/lib/notify';
import { isTeamAlertEvent } from '@/lib/notify-rules';
import { handOffHost } from '@/lib/workflow/review-handoff';
import type { QuestionCheckDeps } from '@/lib/question-gate-check';
import { fileRecoverableBlockerRepair } from '@/lib/recoverable-blocker-repair';
import type { ShippingPrMergedReader } from '@/lib/integration-refresh';
import { missionShippingPrMerged } from '@/lib/mission-shipping-pr';
import { missionEpochHooks } from '@/lib/mission-epoch-hooks';
import type { MissionEpochHooks } from '@/lib/workflow/delivery-epochs';
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
import { attachVisualAuditRecapture } from '@/app/api/workers/claim/visual-audit-recapture';
import { attachVisualAuditSpecCriteria } from '@/app/api/workers/claim/visual-audit-spec-criteria';
import { recordVisualVerdict } from '@/lib/visual-audit-spec-verdict';
import { checkSpecDuplicates, recordDuplicateOverride } from '@/lib/spec-duplicate-decision';
import { classifySpecArea, recordAreaOverride } from '@/lib/spec-area-decision';
import { proposeSpecTaxonomy } from '@/lib/spec-taxonomy-decision';
import { decidePublication, recordPublicationOverride } from '@/lib/spec-publication-decision';

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
 * Told every write of work (lib/work-changed.ts): a task's status or mission,
 * a worker's status or PR, a delivery, a review, and every core event's ids.
 * The missions module refreshes the stored summary of each mission they
 * belong to, after the response (spec 3ef37387 R-13). (Before these run,
 * core itself bumps the change version of the batch's workspaces:
 * lib/work-changed.ts, R-20.)
 */
export const WORK_CHANGE_LISTENERS: readonly WorkChangeListener[] = [
  async (batch) => { await refreshMissionSummariesFor(batch); },
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
 * The workflow kernel's slots (docs/specs/workflow-kernel-library.md §2). Core
 * composes the kernel once from them (`workflowKernel()` in
 * lib/workflow/kernel-ports.ts): buildd's adapters for the kernel's ports, and
 * the effect handler map the drain runs. The kernel (core) decides and
 * records the effect.
 *
 * `workflowKernelHooks()`: each module's half of the ports. Every effect
 * handler is the package's and runs on these:
 *  - reviews: how GitHub's merge answer reads as T16, the activity render, the
 *    review loop's host half (`reviewsHost`: a reviewer's output, the §5.9
 *    composition attestation, a review GitHub refused, the approval's
 *    supersession, the escalation notice), the conflict families' git work
 *    (`conflictsHost`), and legacy's first review for a delivery the kill
 *    switch released (`handOffHost`, so the PR is never left with no
 *    reviewer);
 *  - reviews, missions: the supersession scan, the edge's projection and the
 *    mission wake, the post-merge work and mission-PR finalize;
 *  - per role the task `Work` files: the reviewer and the review fix
 *    (reviews), the CI fix or schema-drift diagnose, the conflict fix, the
 *    trunk fix; with the CI job-log capture;
 *  - each repair family's hand-off to a person (`Escalate`, by family);
 *  - notifications: team notices;
 *  - decisions: the decision model at the kernel's decision points (`Decide`).
 *
 * Built on first use, not at load: the handler modules reach back into this
 * file through core-emit (post-merge work emits events), so composing them at
 * load time works or throws depending on which module a process imports first.
 * The activity render is loaded on its first render, as it was before the
 * kernel composed it.
 */
const ESCALATE_BY_FAMILY: Record<string, Escalate> = { ci: ciEscalate, review_fix: reviewEscalate, conflict: conflictEscalate, migration: conflictEscalate };

/** `exec` and `repoFor`: the db handle and repo lookup a caller injected (the seam's deps), for the ports that read them. */
export function workflowKernelHooks(opts: { exec?: Parameters<typeof handOffHost>[0]; repoFor?: Parameters<typeof handOffHost>[1] } = {}): BuilddKernelHooks {
  return {
    mergeAnswerOf,
    notify: {
      activity: async (p) => (await import('@/lib/workflow/pr-activity-effects')).activityNotify().activity(p),
      team: async (p) => {
        // A kind notify does not know would be dropped by its routing: refuse it loudly instead.
        if (!isTeamAlertEvent(p.kind)) throw new Error(`unknown team alert kind: ${p.kind}`);
        await notifyTeamOf({ workspaceId: p.workspaceId, prNumber: p.prNumber ?? undefined }, p.kind, {
          title: p.title, message: p.body ?? '', ...(p.url ? { url: p.url } : {}), ...(p.urlTitle ? { urlTitle: p.urlTitle } : {}),
        });
      },
    },
    lifecycle: { ...supersessionLifecycle, ...landingLifecycle },
    work: { review: reviewWork, fix: fixWork, capture: captureWork, ci_fix: ciFixWork, conflict_fix: conflictFixWork, trunk_fix: trunkFixWork, external_merge_fix: externalMergeFixWork },
    escalate: {
      exhausted: (d, n) => {
        const e = ESCALATE_BY_FAMILY[n.family];
        if (!e) throw new Error(`no escalation for family ${n.family}`);
        return e.exhausted(d, n);
      },
    },
    evidence: ciEvidence,
    reviews: reviewsHost,
    conflicts: conflictsHost,
    handOff: handOffHost(opts.exec, opts.repoFor),
    decide: builddDecide,
    // The merge rails the merge effect reads at merge time; the mission-PR hold is the missions module's.
    rails: builddLandingRails({ missionGate: (task) => guardMissionPrMerge(task) }),
  };
}

/**
 * The open-PR status sweep's review reads (lib/workflow/open-pr-status.ts): whether a
 * review was asked for on a PR no delivery owns, and a release candidate's gate at its SHA.
 * The releases module's (lib/release/open-pr-review.ts); lazy, so the floor loads it only when it runs.
 */
export async function openPrReviewReads(): Promise<import('@/lib/release/open-pr-review').OpenPrReviewReads> {
  return (await import('@/lib/release/open-pr-review')).openPrReviewReads();
}

/**
 * The event doors of `Buildd / Review approval` on an open PR head (lib/workflow/open-pr-events.ts):
 * the GitHub webhook, the worker route's recorded verdict and a stored review request call it, so the
 * status follows the event instead of the hourly floor. Lazy, so a route loads it only when it runs.
 */
export async function republishPrHeads(
  ...args: Parameters<typeof import('@/lib/workflow/open-pr-events').republishPrHeads>
): Promise<void> {
  return (await import('@/lib/workflow/open-pr-events')).republishPrHeads(...args);
}

/**
 * The question gate's recover slot (lib/question-gate-check.ts): a recoverable
 * blocker an agent tried to ask about is filed as a repair task instead.
 */
export const RECOVERABLE_BLOCKER_REPAIR: NonNullable<QuestionCheckDeps['fileRepair']> = fileRecoverableBlockerRepair;

/**
 * The other half of that slot (lib/recoverable-blocker-reconcile.ts): a
 * completed task, or a park tagged with a completed repair, resumes every task
 * parked on the repair. A no-op for any other task. Lazy, like republishPrHeads.
 */
export async function reconcileRecoverableBlockerRepair(
  task: { id: string; context?: unknown; summary?: string | null },
): Promise<void> {
  const m = await import('@/lib/recoverable-blocker-reconcile');
  if (task.context !== undefined && !m.isRecoverableBlockerRepair(task.context)) return;
  await m.reconcileBlockedOnRepair(m.dbReconcilePort(), { id: task.id, summary: task.summary ?? null });
}

/**
 * The worker route's shipped-PR slot (lib/integration-refresh.ts): the missions
 * module says whether a mission's shipping PR merged, so a refresh task with
 * nothing left to ship can complete on that evidence.
 */
export const MISSION_SHIPPING_PR_MERGED: ShippingPrMergedReader = (missionId, repo, branch) => missionShippingPrMerged(missionId, repo, branch);

/**
 * The kernel's mission epoch slot (lib/workflow/delivery-epochs.ts): the
 * missions module answers the mission's open work, the mission PR it recorded
 * before epochs, and which workspace's repo holds its branches.
 */
export const MISSION_EPOCH_HOOKS: MissionEpochHooks = missionEpochHooks;

/**
 * The scope-answer slot (docs/specs/workflow-kernel-library.md §6): the task
 * routes record a person's answer to a held mission scope decision through the
 * missions module's door (lib/mission-epoch-door.ts), loaded on first use.
 */
type ScopeAnswerInput = Parameters<typeof import('@/lib/mission-epoch-door').answerMissionTaskScope>[0];
export const MISSION_SCOPE_ANSWER = {
  answer: async (p: ScopeAnswerInput) => (await import('@/lib/mission-epoch-door')).answerMissionTaskScope(p),
  answerQuietly: async (p: ScopeAnswerInput) => (await import('@/lib/mission-epoch-door')).answerMissionTaskScopeQuietly(p),
};

/**
 * The escalation gate's slots (lib/escalation-gate-check.ts): Jev, the ledger
 * and the repair filer, for a core caller such as Home that gates PRs.
 */
export const ESCALATION_GATE_DEPS = escalationGateDeps;
/** What a page passes: stored verdicts and rules, the rest looked at after the response. */
export const ESCALATION_GATE_READ_DEPS = escalationGateReadDeps;

/**
 * The connectors module's slot for Home (lib/capability-grants-needs-you.ts):
 * pending capability requests the escalation gate gives to a person, as one
 * statement for Home's batch. A fixed rule; no model call, no write.
 */
export const ACCESS_NEEDS_YOU = accessNeedsYouRead;

/** Open schedule move proposals, for the people who may answer them (lib/schedule-move-needs-you.ts). */
export const SCHEDULE_MOVE_NEEDS_YOU = async (workspaceIds: readonly string[]) =>
  (await import('@/lib/schedule-move-needs-you')).scheduleMoveNeedsYouRead(workspaceIds);

/**
 * The missions module's slot for Home (lib/mission-summary-home.ts): live
 * readings for missions with no stored summary yet, the after-response
 * summary write, and filing a visual review a mission PR owes.
 */
export const HOME_MISSION_SUMMARIES = homeMissionSummaries;

/**
 * The missions module's slot for GET /api/tasks?include=missionStages
 * (`buildd top`'s one combined read): each named mission's stage from its
 * stored summary, scoped to the caller's workspaces, at most
 * MAX_STAGE_MISSION_IDS missions, the same reader GET /api/missions/stages uses.
 */
export const TASK_LIST_MISSION_STAGES = (missionIds: string[], workspaceIds: string[]) =>
  loadMissionStagesFromSummaries(missionIds.slice(0, MAX_STAGE_MISSION_IDS), workspaceIds);

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
  await attachVisualAuditRecapture(claimedWorkers, claimedTasks);
  await attachVisualAuditSpecCriteria(claimedWorkers, claimedTasks);
};

/**
 * The visual-qa module's spec verdict slot (lib/visual-audit-spec-verdict.ts):
 * POST /api/specs/outcomes/[taskId] with `checker: 'visual'` records what a
 * mission's [surface audit] saw on a spec criterion.
 */
export const VISUAL_SPEC_VERDICT = recordVisualVerdict;

/**
 * The visual-qa module's registered verification slot
 * (lib/specs/registered-verification-store.ts): the store behind the core
 * coordinator (lib/specs/registered-verification.ts). It admits only captures an
 * independent [surface audit] uploaded, and resolves the head and who may ask.
 * POST /api/specs/outcomes/[taskId]/verify runs the coordinator with it.
 */
const registeredStore = () => import('@/lib/specs/registered-verification-store');
export const REGISTERED_VERIFICATION = {
  deps: async () => (await registeredStore()).registeredVerificationDeps,
  head: async (taskId: string) => (await registeredStore()).registeredVerificationHead(taskId),
  requesterRefusal: async (requesterTaskId: string, subjectTaskId: string) =>
    (await registeredStore()).verificationRequesterRefusal(requesterTaskId, subjectTaskId),
};

/**
 * The decisions module's spec duplicate slot (lib/spec-duplicate-decision.ts):
 * createSpecDraft compares a new spec with the approved ones, and records a
 * person's override of a refusal on the ledger rows that refused it.
 */
export const SPEC_DUPLICATE_CHECK = checkSpecDuplicates;
export const SPEC_DUPLICATE_OVERRIDE = recordDuplicateOverride;

/**
 * The knowledge module's spec draft slot (lib/specs/knowledge.ts, R-106): after
 * a revision is written, its draft head is indexed into the spec corpus once
 * the response is out. Loaded on first use, like the similarity install below.
 */
export const SPEC_DRAFT_INDEX = async (specId: string): Promise<void> => {
  const { scheduleSpecDraftIndex } = await import('@/lib/specs/knowledge');
  scheduleSpecDraftIndex(specId);
};

/**
 * The decisions module's spec area slot (lib/spec-area-decision.ts): organize
 * (lib/specs/organize.ts) asks which area an unfiled spec belongs in, and a
 * person's move of a spec buildd filed is recorded on that filing's ledger row.
 */
export const SPEC_AREA_CLASSIFY = classifySpecArea;
export const SPEC_AREA_OVERRIDE = recordAreaOverride;

/**
 * The decisions module's spec taxonomy slot (lib/spec-taxonomy-decision.ts):
 * organize, on a workspace with no areas, asks the team's decision model to
 * sort its specs into a proposed taxonomy; `ran: false` means the word-based
 * fallback in lib/specs/areas.ts proposes instead.
 */
export const SPEC_TAXONOMY_PROPOSE = proposeSpecTaxonomy;

/**
 * The decisions module's spec publication slot (lib/spec-publication-decision.ts):
 * the repo copy (lib/specs/repo-copy.ts) asks whether an approved revision may
 * leave buildd before anything is written to GitHub, and a person's "Publish
 * anyway" is recorded on that decision's ledger row.
 */
export const SPEC_PUBLICATION_DECIDE = decidePublication;
export const SPEC_PUBLICATION_OVERRIDE = recordPublicationOverride;

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

/** Claim declares this policy slot; coordination owns its evidence and persistence. */
export const CLAIM_LEARNING_HOOKS: import('@/app/api/workers/claim/learning-hooks').ClaimLearningHooks = {
  areaClass: claimAreaClass,
  get fingerprint() { return CLAIM_HOLD_DECISION.fingerprint; },
  loadPolicy: async (gate, area) => (await import('@buildd/core/orchestration-claim-learning-source')).loadClaimLearningPolicy(gate, area),
  record: async (row, replay) => (await import('@buildd/core/orchestration-ledger-source')).recordOrchestrationDecision(row, replay),
};

/** Task filing reach refusal: optional schedules module observes repeated refusals. */
export const TASK_REACH_REFUSAL = async (...args: Parameters<typeof import('@/lib/schedule-move').noteScheduleRefusal>) =>
  (await import('@/lib/schedule-move')).noteScheduleRefusal(...args);
