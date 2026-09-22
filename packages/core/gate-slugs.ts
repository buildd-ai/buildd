/**
 * The gate vocabulary — the slug catalogue, and nothing else.
 *
 * A slug names the RULE, not the message. Renaming one forks its own history —
 * old rows keep the old slug and the aggregation reports two gates where there
 * is one — so add here rather than editing in place, and treat a rename as a
 * data migration.
 *
 * Split out of `gate-events.ts` (which keeps the writer) because that module
 * imports the DB client, and the DB client is `server-only`: importing it
 * anywhere but a Next server context throws. The runner has to recognise a
 * gate slug the server echoed back to it, so the names must live in a module
 * with NO imports at all. Keep it that way — one vocabulary, importable from
 * both sides, is the whole point.
 */
export const GATE_SLUGS = {
  /** POST /api/tasks — out-of-vocabulary `kind` / `complexity`. */
  TASK_PARAM_VOCABULARY: 'task_param_vocabulary',
  /** POST /api/tasks — advisory prose dependency-gate lint. */
  PROSE_GATE: 'prose_gate',
  /**
   * POST /api/tasks — a mission task filed with no `kind`. ADVISORY ONLY:
   * nothing is rejected. `kind` is meaningful on every task, so a hard gate
   * would fire on all of them including the `[friction]` filing an agent makes
   * while already failing — the caller least able to absorb a rejection. The
   * value here is measurement: `get_failure_analytics family="gate"` reports how
   * often the field is skipped and by which caller origin, which is the evidence
   * a future decision to harden it would need.
   */
  KIND_ABSENT: 'kind_absent',
  /** POST /api/tasks — `[friction]` filing folded into an open task. */
  FRICTION_DEDUPE: 'friction_dedupe',
  /** POST /api/tasks — subject-anchor attach, and its `fileAnywayReason` bypass. */
  SUBJECT_DEDUPE: 'subject_dedupe',
  /** POST /api/tasks — `fileAnywayReason` itself refused (blank / wrong origin). */
  FILE_ANYWAY: 'file_anyway',
  /** POST /api/tasks — mission PR task with no concrete pathManifest. */
  MANIFEST_REQUIRED: 'manifest_required',
  /** POST /api/tasks — `emitsPlan: true` task filed with no pathManifest naming the spec doc it authors. */
  EMITS_PLAN_MANIFEST_REQUIRED: 'emits_plan_manifest_required',
  /** Missions create/update — `branchStrategy` validation. */
  BRANCH_STRATEGY: 'branch_strategy',
  /** Missions create/update — `goalCriteria` validation, incl. notMechanizableReason. */
  GOAL_CRITERIA: 'goal_criteria',
  /** PATCH /api/workers/[id] — the outputRequirement completion gate, and `discardEdits`. */
  OUTPUT_REQUIREMENT: 'output_requirement',
  /** PATCH /api/workers/[id] — refusing to adopt a PR that targets the wrong base. */
  MISSION_BASE_ADOPTION: 'mission_base_adoption',
  /**
   * PATCH /api/workers/[id] — a runner reporting that a prior mutation of OURS
   * was refused (a non-gate 4xx, or an unqueueable 5xx). Those reports are
   * exempt from the task's retry budget, so this row is what keeps the
   * exemption countable instead of invisible: a rise here means the runner is
   * sending requests we reject, not that agents are failing.
   */
  WORKER_PATCH_REFUSED: 'worker_patch_refused',
  /** create_pr — head is not the worker's own branch. */
  PR_HEAD_MISMATCH: 'pr_head_mismatch',
  /** create_pr — base disagrees with the mission integration branch. */
  PR_BASE_MISMATCH: 'pr_base_mismatch',
  /** merge_pr — workspace merge policy, and the admin `force` bypass. */
  MERGE_POLICY: 'merge_policy',
  /** merge_pr — mission-PR branch-lifecycle wait. */
  MISSION_PR_LIFECYCLE: 'mission_pr_lifecycle',
  /** Every merge door — an outstanding non-approve verdict, or a review round still in flight, at the commit being merged. Carries the human `override` bypass. */
  REVIEW_VERDICT: 'review_verdict',
  /** check_path_claim — wildcard refusal and real-overlap deferral. */
  PATH_CLAIM: 'path_claim',
  /** request_pr_review — one reviewer per PR at a time. */
  REVIEWER_SINGLE_FLIGHT: 'reviewer_single_flight',
  /** POST /api/workers/claim — a candidate task examined and deferred in the dispatch loop, or a claim attempt itself refused. Also carries the stranded-task sweep's `outcome: 'stranded'` rows. */
  CLAIM_LOOP_DEFERRAL: 'claim_loop_deferral',
  /** Mission goal-criteria evaluation resolving to NOT_EVALUATED/UNVERIFIED instead of a real verdict. */
  CRITERIA_NOT_EVALUATED: 'criteria_not_evaluated',
} as const;

export type GateSlug = (typeof GATE_SLUGS)[keyof typeof GATE_SLUGS];
