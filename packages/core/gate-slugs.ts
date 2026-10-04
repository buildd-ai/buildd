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
  /**
   * Missions create/update — ADVISORY ONLY: a goal criterion the shadow decision
   * verdict graded weak (no user-noticeable outcome, or not checkable without
   * reading prose). Never blocks, never rewrites. Separate from GOAL_CRITERIA,
   * which is the validation 400. See docs/specs/mission-goal-criteria-quality.md.
   */
  GOAL_CRITERIA_QUALITY: 'goal_criteria_quality',
  /** PATCH /api/workers/[id] — the outputRequirement completion gate, and `discardEdits`. */
  OUTPUT_REQUIREMENT: 'output_requirement',
  /** Empty editing session with a non-outcome summary. */
  SILENT_COMPLETION: 'silent_completion',
  /** PATCH /api/workers/[id] — the handoff completion gate: tasks with dependents must include handoff.delivered. */
  HANDOFF_REQUIRED: 'handoff_required',
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
  /**
   * create_pr / worker PATCH — an agent run recording a PR its task does not
   * own (head not its branch, lineage, dependency or a PR it names; a
   * protected head; or a PR outside the workspace's linked repo).
   */
  PR_OWNERSHIP: 'pr_ownership',
  /** merge_pr — workspace merge policy, and the admin `force` bypass. */
  MERGE_POLICY: 'merge_policy',
  /** merge_pr — mission-PR branch-lifecycle wait. */
  MISSION_PR_LIFECYCLE: 'mission_pr_lifecycle',
  /** Every merge door — an outstanding non-approve verdict, or a review round still in flight, at the commit being merged. Carries the human `override` bypass. */
  REVIEW_VERDICT: 'review_verdict',
  /** check_path_claim — wildcard refusal and real-overlap deferral. */
  PATH_CLAIM: 'path_claim',
  /** create_pr — a delivered warning note about overlapping open change intents. */
  CHANGE_INTENT: 'change_intent',
  /** request_pr_review — one reviewer per PR at a time. */
  REVIEWER_SINGLE_FLIGHT: 'reviewer_single_flight',
  /** POST /api/workers/claim — a candidate task examined and deferred in the dispatch loop, or a claim attempt itself refused. Also carries the stranded-task sweep's `outcome: 'stranded'` rows. */
  CLAIM_LOOP_DEFERRAL: 'claim_loop_deferral',
  /** Mission goal-criteria evaluation resolving to NOT_EVALUATED/UNVERIFIED instead of a real verdict. */
  CRITERIA_NOT_EVALUATED: 'criteria_not_evaluated',
  /**
   * Every merge door (via `evaluateAutoMergeSafety`) — the PR's newest CI
   * result predates the current base tip. A green measured against a base
   * that has since moved is not proof the merge result is green; refusing
   * routes the PR through the same rebase-and-retest path as a real conflict.
   */
  MERGE_BASE_FRESHNESS: 'merge_base_freshness',
  /**
   * A dependency-bot PR (Renovate, Dependabot) — skipped by automatic
   * adoption, and refused by every path that would push to its branch (CI fix,
   * conflict retry, update-branch, review follow-up). The bot owns the branch;
   * one foreign commit stops it rebasing. See `lib/dependency-bot-pr.ts`.
   */
  DEPENDENCY_BOT_PR: 'dependency_bot_pr',
  /**
   * The unattended merge path (`tryAutoMergeWorkerPr`) — a safety-rail refusal
   * (red CI, protected path, size cap, migration, conflict, ...) or a failed
   * merge call. `detail.reasonClass` says which. Base freshness and review
   * verdicts keep their own slugs and are not double-recorded here.
   */
  AUTO_MERGE: 'auto_merge',
  /**
   * Retry-lineage supersession (`lib/retry-pr-supersession.ts`). `stranded`: an
   * ancestor PR that should have been closed when a retry opened a fresh PR was
   * left open (state unreadable, close failed). `warned`: the pr-reconcile
   * sweep found two open PRs in one retry lineage and closed the older — the
   * create_pr door missed it. From create_pr (`lib/retry-fresh-pr-gate.ts`):
   * `rejected` — a retry asked for a fresh PR while its subject PR is open and
   * can carry the work; `warned` — a fresh PR was let through, with
   * `detail.freshPrReason` (`diverged` | `unverified`).
   */
  RETRY_PR_SUPERSESSION: 'retry_pr_supersession',
  /**
   * Automatic supersession of a closed-unmerged PR (`lib/pr-supersession-detect.ts`).
   * `accepted`: content verification (patch-id or content) proved the work is
   * in a merged PR, so the edge was recorded — `detail.method` and
   * `detail.confidence` separate these from a person's edge. `deferred`: a
   * candidate was found but not verified, so only a suggestion was stored.
   */
  AUTO_PR_SUPERSESSION: 'auto_pr_supersession',
  /**
   * The supersession reconciler (`lib/supersession.ts`). `accepted`: one row per
   * task a rule cancelled, written by the CAS winner only — `detail.rule` is the
   * rule id, `detail.event` the subject event. `rejected`: one event matched more
   * than the per-event cap, so nothing was cancelled and `detail.wouldCancel`
   * holds the set.
   */
  SUPERSESSION: 'supersession',
  /**
   * The chat retro proposal pass (apps/web/src/lib/chat-retro/, experiment).
   * `deferred`: a pattern over the daily per-team cap. `rejected`: a signature
   * muted until its evidence doubles, or a pattern with no workspace to file
   * into.
   */
  CHAT_RETRO_PROPOSAL: 'chat_retro_proposal',
  /**
   * A mission's integration branch could not be resolved on the remote —
   * `detail.where` says which path hit it, `detail.fallback` what it did
   * instead (re-cut from trunk, PR to trunk, nothing). The same string is the
   * runner's error-trace pattern; see `@buildd/core/mission-branch-trace`.
   */
  MISSION_BRANCH_UNRESOLVED: 'mission_branch_unresolved',
  /**
   * The PR landing function (`lib/pr-landing.ts`) — every non-merged outcome
   * writes exactly one row: `detail.landingOutcome` is the typed outcome and
   * `detail.prNumber` / `detail.headSha` say which PR and head. In shadow mode
   * the row is `warned` with `detail.shadowOutcome` and nothing was acted on.
   * A merged outcome writes an `accepted` row carrying `detail.timeToLandMs`
   * (or `timeToLandUnmeasured`); non-merged rows carry `detail.approvedGreenAt`
   * once the PR is approved and green. See `lib/pr-landing-metrics.ts`.
   */
  PR_LANDING: 'pr_landing',
  /**
   * Surface merge ordering (`lib/surface-ordering.ts`, conflict-aware-orchestration.md
   * §3). `deferred` = an enforcing wait behind an earlier open PR on a serialized
   * surface (`detail.kind` 'ordering') or unverifiable intent state ('unverified');
   * `warned` = shadow would-defer or a reported cross-surface order inversion;
   * `accepted` = a merge reservation was taken (the denominator); `bypassed` = an
   * explicit authorized override. Distinct from `change_intent`, whose `warned`
   * rows are the advisory overlap notes and never gate anything.
   */
  SURFACE_ORDERING: 'surface_ordering',
  /**
   * Path declaration outcomes and manifest provenance (§3 denominators):
   * `accepted` = declared/acquired, `deferred` = denied by a live holder,
   * `warned` = degraded (coordination unavailable, edits proceeded). `detail.provenance`
   * says where the declaration came from (creation / plan_step / doc_fix /
   * check_path_claim / observed / hook) — the generic MCP histogram cannot.
   */
  PATH_DECLARATION: 'path_declaration',
  /**
   * Deterministic base refresh of a behind-only PR (conflict-aware-orchestration.md
   * §4). `accepted` = GitHub merged the base in (no agent); `deferred` = an
   * operational update failure (`detail.failure`: rate_limit / auth / transient /
   * unknown) or an unverified semantic check awaiting a bounded recheck, or a
   * verified same-symbol edit sent to semantic review (`detail.verdict`);
   * `warned` = shadow semantic verdict or a moved head; `rejected` = attempts
   * exhausted, with an operational diagnostic posted. A textual conflict is
   * never recorded here as an operational failure — it goes to the conflict agent.
   */
  BASE_REFRESH: 'base_refresh',
  /**
   * A red CI result on a buildd PR that got no CI-fix task
   * (`lib/ci-failure-retry.ts`), from the `check_suite` webhook or the red-PR
   * sweep (`lib/ci-red-sweep.ts`). `detail.skipReason` is the stable code:
   * owner_stopped, pr_terminal, no_workspace, draft, pr_merged, pr_closed,
   * fix_in_flight, head_already_retried, retries_exhausted, retries_disabled,
   * duplicate. `deferred` = someone still owes a push (a fix in flight);
   * `rejected` = nothing will act on this head; `stranded` = the sweep found a
   * head an attempt already ran on with nothing pushed, and escalated it.
   */
  CI_RETRY_SKIPPED: 'ci_retry_skipped',
  /**
   * POST /api/tasks — the organizer's own planning task tried to create a
   * decomposition child while sibling tasks the mission creator pre-filed
   * (after that planning task was created) are still live. The pre-filed
   * heuristic in `runMission()` only runs once, at planning-task creation —
   * before a creator who files right after `manage_missions create` gets a
   * chance to. This is the same check re-run at the point decomposition
   * actually happens. Retry children (explicit `parentTaskId`) are exempt.
   */
  DECOMPOSITION_REFUSED: 'decomposition_refused',
  /**
   * A workflow-kernel effect went `dead` after its last retry
   * (`lib/workflow/dead-effects.ts`, docs/specs/workflow-state-kernel.md §10.3).
   * `stranded` = a critical effect; the kernel applied `EffectDead` and the
   * delivery is ESCALATED (`detail.applied` says whether it moved). `warned` =
   * a non-critical effect; nothing escalates, the row is the alert.
   */
  WORKFLOW_EFFECT_DEAD: 'workflow_effect_dead',
  /**
   * GitHub webhook — a PR merged or commits were pushed onto a live worker's
   * base, touching files in its scope (observed touches ∪ declared manifest),
   * so it was told to rebase (`lib/base-advance-notice.ts`). ADVISORY: nothing
   * is blocked. `warned` = one notice queued; later changes inside the debounce
   * window fold into the same row (`detail.coalesced`, `detail.coalescedChanges`).
   * The denominator for "do notified workers conflict less".
   */
  BASE_ADVANCE_NOTICE: 'base_advance_notice',
  /**
   * Keeping a mission's integration branch current with dev
   * (`lib/mission-branch-refresh.ts`, docs/design/mission-delivery-arc.md P5,
   * superseded). `accepted` = GitHub's merges API landed dev cleanly (a merge
   * commit, no agent); `deferred` = the single-flight lease is already held
   * (debounced) or dev has not moved past the last recorded refresh
   * (`detail.reason`); `stranded` = a 409 conflict dispatched the
   * conflict-resolution task named in `detail.conflictTaskId`, or one was
   * already open and nothing new was dispatched.
   */
  MISSION_BRANCH_REFRESH: 'mission_branch_refresh',
} as const;

export type GateSlug = (typeof GATE_SLUGS)[keyof typeof GATE_SLUGS];
