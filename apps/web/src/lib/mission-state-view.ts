/**
 * `MissionStateView` — the one owner of "what state is this in, and what is it
 * waiting on?".
 *
 * Specified by `docs/design/mission-state-ownership.md`. The mission this
 * accessor closes had four panels answering that question independently, with
 * equal confidence and no label saying what each was computed from, so a
 * mission that could not complete rendered as "No actions needed".
 *
 * ## It does not re-derive anything
 *
 * Five derivations already exist and each is authoritative for its own axis.
 * This module consumes their OUTPUTS and owns only the precedence between them:
 *
 * | Source | Axis it owns | Module |
 * |---|---|---|
 * | `deriveTaskHealthSignal` | are tasks failing / stuck / gated? | `mission-helpers.ts` |
 * | `deriveCriteriaGatePresentation` | how does the completion gate present? | `@buildd/core/mission-helpers` |
 * | `canCompleteMission` | may this mission close, and if not why? | `mission-completion.ts` |
 * | `classifyMissionWait` | is every open task on a self-resolving wait, until when? | `heartbeat-prepass.ts` |
 * | `evaluateMissionWorkState` | has the deliverable work reached the branch? | `mission-pr.ts` |
 *
 * Nothing here re-implements those. Everything here is a rule about which one
 * wins when two of them describe the same mission differently.
 *
 * ## The two precedence rulings this module owns
 *
 * **1. Criteria never produce `blocked`.** `canCompleteMission` returns
 * `criteria_failed` / `criteria_unverified` — refusals — while
 * `deriveCriteriaGatePresentation` states that an unverified *or failing*
 * criterion "does not stop work; it only withholds a completion verdict, so it
 * must never render as BLOCKED". Both are right about their own question. The
 * ruling: a criteria refusal yields `awaiting_verification`, never `blocked`,
 * and its tone escalates `neutral → warning → error` with the gate's own state
 * (`unverified → failing → refused`). An unverified criterion on a young
 * mission is therefore quiet by construction, and `blocked` stays reserved for
 * states where work genuinely cannot proceed.
 *
 * **2. A benign wait outranks a stall.** `deriveTaskHealthSignal` reports
 * `STALLED` for open tasks with no live worker; `classifyMissionWait` reports
 * that those same tasks are on a known self-resolving condition with a
 * wait-until. When both fire, the wait wins — "the platform failed to progress
 * this" and "this resumes by itself at 14:20" are opposite claims and only one
 * of them is actionable.
 *
 * ## Why a blocked mission cannot render as idle
 *
 * `MissionStateView` is a discriminated union, not a record with an optional
 * field. `waitingOn: null` exists ONLY on the `complete` / `idle` / `running`
 * variants; every gated variant carries a non-null `WaitingOnDescriptor`. A
 * panel that wants to render "nothing to do" must narrow to a variant where
 * `waitingOn` is typed `null` — it cannot reach that branch while the mission
 * is gated, because the compiler will not let it. That is the DerivedMetric
 * precedent (`docs/design/derived-metric-availability.md`) applied to state:
 * absence is a variant, not a falsy value.
 *
 * The view is also branded. `MissionStateViewBrand` is a module-private unique
 * symbol, so an object literal assembled at a call site cannot satisfy the type
 * — `deriveMissionStateView` is the only producer.
 *
 * ## Every field says where it came from
 *
 * `derivedFrom` names the source for the kind, for `waitingOn` and for
 * `nextAction`. The failure this whole line of work exists to prevent is
 * several surfaces answering with equal confidence and no label saying what
 * each was computed from.
 *
 * ## Precedence must not zero out the other facts
 *
 * `waitingOn` is the PRECEDENCE VERDICT — the one blocker that best describes
 * the mission. It is deliberately a single value, and rule 5 (a live worker is
 * observable ground truth) short-circuits the chain above merge, criteria and
 * open-task rules.
 *
 * That is correct for `kind`, and wrong for a screen. A mission can have a live
 * worker AND an open mission PR AND an unmet criterion; if one stale worker row
 * makes `activeAgents` non-zero, `running` wins, `waitingOn` goes null, and a
 * surface reading only `waitingOn` says "nothing outstanding" over the top of an
 * unmerged PR. That is the same class of bug as the false-zero counts fixed in
 * #2355: populate every fact, and let the verdict carry precedence rather than
 * erase its rivals.
 *
 * So `outstanding` is a SECOND, unranked answer: every fact that is true right
 * now, independent of which one won. It is populated on every variant including
 * the quiet ones. A fact whose whole claim is "nothing is executing" (a stall,
 * a self-resolving wait) is refuted by a live worker and is the one thing NOT
 * reported alongside `running` — it would be a false statement, not a demoted
 * one.
 *
 * `situation` is what both the mission header and the mission card render: one
 * plain-language line built from `kind` + the highest-ranked outstanding fact,
 * with the action that clears it. One derivation, two surfaces.
 */
import type { CriteriaGatePresentation } from '@buildd/core/mission-helpers';
import type { CompletionDecisionCode } from '@buildd/core/mission-completion-codes';
import { isCriteriaBlockCode, isMergeBlockCode } from '@buildd/core/mission-completion-codes';
import type { Health, MissionDisplayState } from './mission-helpers';
import { getMissionStateChip } from './mission-helpers';
import { isSurfaceAuditTask } from '@buildd/core/surface-audit';
import { isRepeatedlyDeferred, SURFACE_DEFERRAL_MS } from './claim-deferral-thresholds';

// ─── Provenance ───────────────────────────────────────────────────────────────

/**
 * Which derivation produced a given answer. Not free text: a caller rendering
 * `derivedFrom` is naming a function another agent can go and read.
 */
export type MissionStateSource =
  | 'mission.status'
  | 'mission.startMode'
  | 'mission.criteriaEscalatedAt'
  | 'workers.live'
  | 'deriveTaskHealthSignal'
  | 'deriveCriteriaGatePresentation'
  | 'canCompleteMission'
  | 'classifyMissionWait'
  | 'evaluateMissionWorkState'
  | 'gateEvents.claimLoopDeferral'
  | 'workers.prUrl + workers.mergedAt'
  | 'tasks.parentTaskId + tasks.taskClass';

export interface MissionStateProvenance {
  /** What produced `kind`. */
  kind: MissionStateSource;
  /** What produced `waitingOn`. Null exactly when `waitingOn` is null. */
  waitingOn: MissionStateSource | null;
  /** What produced `nextAction`. Null exactly when `nextAction` is null. */
  nextAction: MissionStateSource | null;
}

// ─── What it is waiting on ────────────────────────────────────────────────────

/**
 * How loudly a blocker should render.
 *
 * `neutral` is load-bearing: an unverified criterion on a mission that has not
 * finished its work is not news, and rendering it as an alarm is the bug that
 * trained readers to ignore the banner.
 */
export type WaitingOnTone = 'neutral' | 'info' | 'warning' | 'error';

/**
 * The blocker, with hard references rather than prose. Every variant carries
 * whatever authoritative ids exist for it — a caller assembling a causal chain
 * reads these, it does not parse `label`.
 *
 * A switch over `kind` must be exhaustive to compile: adding a variant without
 * updating a renderer is a type error, which is the point.
 */
export type WaitingOnDescriptor =
  /** An upstream mission's gate condition has not been met. */
  | { kind: 'dependency'; tone: WaitingOnTone; label: string; missionId: string }
  /** Deliverable tasks are open, and nothing is live on them. */
  | {
      kind: 'task';
      tone: WaitingOnTone;
      label: string;
      count: number;
      taskIds: string[];
      /** Status histogram of the open rows, e.g. `{ pending: 2 }`. */
      byStatus: Record<string, number>;
      /**
       * Set when the open row is a fix attempt on work that already produced a
       * PR (builder-after-review, CI retry). `claimed` separates "queued" from
       * "a worker has it" — the two read very differently to someone waiting.
       */
      attempt?: { iteration: number | null; maxIterations: number | null; claimed: boolean };
    }
  /** A deliverable failed. `infra` distinguishes "failed on infrastructure" from "failed on its merits". */
  | { kind: 'task_failed'; tone: WaitingOnTone; label: string; infra: boolean; taskIds: string[]; titles: string[] }
  /** Work is done; a PR has not merged. Covers the mission integration PR too. */
  | {
      kind: 'merge';
      tone: WaitingOnTone;
      label: string;
      count: number;
      prNumbers: number[];
      /**
       * Hrefs for the unmerged PRs, in the same order as `prNumbers` where both
       * are known. Carried so a surface can WIRE the primary action rather than
       * printing a number the reader has to go and find — a "merge the mission
       * PR" affordance with nowhere to go is the button wall again, one row
       * shorter.
       */
      prUrls: string[];
      taskIds: string[];
      /** True when the unmerged PR is the mission's own integration PR, not a task PR. */
      missionPr: boolean;
    }
  /**
   * The completion gate is holding on a criterion that failed.
   *
   * `blockers` names what holds a structural criterion (`no_open_tasks`: the
   * open deliverables; `all_prs_merged`: the unmerged PRs), all of them — a
   * surface shows `CRITERION_BLOCKERS_VISIBLE` and "+N more". `stale` is set
   * when the stored verdict is contradicted by the rows loaded now: it failed
   * on open tasks, and none is open any more. The completion gate still reads
   * the stored verdict, so the next step is to re-run verification.
   */
  | {
      kind: 'criterion_failing';
      tone: WaitingOnTone;
      label: string;
      count: number;
      criteria: string[];
      refused: boolean;
      blockers?: CriterionBlocker[];
      stale?: boolean;
    }
  /**
   * The completion gate has no verdict yet. Quiet by construction — see the
   * module note — EXCEPT when `awaitingRunner` names criteria whose runner
   * verification task has sat unclaimed past the wait bound: then nothing is
   * verifying them, and saying "not yet verified" would hide that.
   */
  | { kind: 'criterion_unverified'; tone: WaitingOnTone; label: string; count: number; criteria: string[]; awaitingRunner?: string[] }
  /** A human owes an answer; nothing automated will move this. */
  | { kind: 'human_decision'; tone: WaitingOnTone; label: string; detail: string | null }
  /**
   * Everything open is on a known self-resolving condition. Resumes by itself.
   * `waitUntil` is null when the wait is known but its resume time is not —
   * an empty string would read as a timestamp nobody can parse.
   */
  | { kind: 'self_resolving_wait'; tone: WaitingOnTone; label: string; reason: string; waitUntil: string | null }
  /**
   * The claim loop has refused the same task for the same reason enough
   * consecutive polls to stop being contention. Never a precedence verdict —
   * it is reported alongside whatever `kind` says, because the failure it
   * describes is precisely a mission that LOOKS like it is running.
   */
  | {
      kind: 'claim_deferral';
      tone: WaitingOnTone;
      label: string;
      /** How many tasks are sitting behind a gate this way. */
      count: number;
      /** The normalized gate reason of the worst offender, e.g. `workspace_cap`. */
      reason: string;
      /** Consecutive deferrals on the worst offender. */
      consecutiveDeferrals: number;
      /** When the worst offender was first deferred, if the ledger recorded it. */
      firstDeferredAt: string | null;
      /** For `path_overlap`: the open PR the worst offender is waiting on. */
      blockedByPr?: number | null;
      taskIds: string[];
    };

/** A task holding a structural criterion at fail. `status` is display text (`queued`, `PR #12 open`). */
export interface CriterionBlocker {
  taskId: string;
  title: string;
  status: string;
}

/** How many blockers a surface names before "+N more". */
export const CRITERION_BLOCKERS_VISIBLE = 3;

// ─── The view ─────────────────────────────────────────────────────────────────

/** The mutually-exclusive answers to "what is this mission doing?". */
export type MissionStateKind =
  | 'complete'
  | 'idle'
  | 'running'
  | 'held'
  | 'blocked'
  | 'waiting'
  | 'awaiting_merge'
  | 'awaiting_verification'
  | 'awaiting_decision'
  | 'failing';

/** Kinds on which `waitingOn` is typed `null` — the only states that may render as "nothing to do". */
export type QuietMissionStateKind = 'complete' | 'idle' | 'running';

/** Kinds that always carry a blocker. */
export type GatedMissionStateKind = Exclude<MissionStateKind, QuietMissionStateKind>;

/**
 * Type-only brand. There is no runtime symbol and the factory never writes this
 * key — it exists purely so an object literal assembled at a call site is not
 * assignable to `MissionStateView`. Same mechanism as `DerivedMetric`'s
 * constructor helpers, one level stricter: there, a literal is merely
 * discouraged; here it will not compile.
 */
declare const MissionStateViewBrand: unique symbol;

interface MissionStateViewBase {
  readonly [MissionStateViewBrand]: true;
  /** Header chip label + token classes. Computed once; never reconstructed at a call site. */
  readonly chip: { label: string; cls: string };
  /**
   * The legacy display state, so a panel already taking `MissionDisplayState`
   * adopts this view without changing its signature.
   */
  readonly displayState: MissionDisplayState;
  /**
   * The above-fold banner string for a criteria hold, or null. Derived from
   * `waitingOn` — never computed a second time.
   */
  readonly criteriaBlockingReason: string | null;
  /**
   * Every fact that is outstanding right now, ranked, INDEPENDENT of which one
   * won precedence — see "Precedence must not zero out the other facts" above.
   * Populated on every variant, including `running` and `idle`; empty only when
   * no source reports anything.
   *
   * `waitingOn` (when non-null) is always the first entry, so a caller that
   * renders `outstanding` renders the verdict too.
   */
  readonly outstanding: readonly WaitingOnDescriptor[];
  /** The one line the header and the card both render. */
  readonly situation: MissionSituation;
  readonly derivedFrom: MissionStateProvenance;
}

/**
 * The sealed mission state.
 *
 * `waitingOn: null` is reachable only on `complete` / `idle` / `running`. A
 * renderer that narrows to those three has proved the mission is not gated; it
 * cannot reach that branch any other way.
 */
export type MissionStateView =
  | (MissionStateViewBase & {
      readonly kind: QuietMissionStateKind;
      readonly waitingOn: null;
      readonly nextAction: string | null;
    })
  | (MissionStateViewBase & {
      readonly kind: GatedMissionStateKind;
      readonly waitingOn: WaitingOnDescriptor;
      readonly nextAction: string;
    });

/** True when the mission is gated. Narrows to the variant that carries a blocker. */
export function isGated(
  view: MissionStateView,
): view is Extract<MissionStateView, { kind: GatedMissionStateKind }> {
  return view.waitingOn !== null;
}

// ─── Inputs ───────────────────────────────────────────────────────────────────

/**
 * Everything the accessor reads, all of it already derived by its own owner.
 *
 * Deliberately NOT a mission row: passing raw fields is how each panel ended up
 * deriving its own answer. A caller that has not run the derivations passes
 * `null` for them and gets an honestly-degraded view — never a confident wrong
 * one, because a missing source can only remove a *reason*, never invent
 * `idle`. (`idle` is the last rule in the chain; it is reached only when every
 * source that could contradict it was consulted and had nothing to say.)
 */
export interface MissionStateInput {
  /** `missions.status`. */
  status: string;
  /** Start gate not released (`startMode === 'held'`). */
  isHeld: boolean;
  /** `missions.orchestrationMode`. */
  orchestrationMode?: string | null;
  /** Live workers on this mission's tasks. */
  activeAgents: number;
  /** 0–100 deliverable progress, when it is defined at all. */
  progress?: number;
  /** From `deriveTaskHealthSignal`. */
  health: Health;
  /** `missions.dependsOnMissionId`, for naming the dependency. */
  dependsOnMissionId?: string | null;
  /** `missions.criteriaEscalatedAt` — the gate handed the mission to its owner. */
  criteriaEscalatedAt?: Date | string | null;
  /** Body of the open escalation note, when one was loaded. */
  escalationDetail?: string | null;
  /** True when a deliverable task is still open. Required to reach `awaiting_decision`. */
  hasPendingDeliverableWork?: boolean;
  /** From `deriveCriteriaGatePresentation`. Null when the mission states no criteria. */
  criteriaGate?: CriteriaGatePresentation | null;
  /** Per-criterion detail, for naming which one is holding. */
  criteriaItems?: Array<{ verdict: string; label?: string; name?: string; type?: string; awaitingRunner?: boolean }>;
  /** From `canCompleteMission`, when a caller ran it. */
  completion?: MissionCompletionSummary | null;
  /** From `classifyMissionWait`, when a caller ran it. */
  wait?: { reason: string; waitUntil: Date | string } | null;
  /** From `evaluateMissionWorkState`, when a caller ran it. */
  workState?: { complete: boolean; reason: string; unfinishedTaskCount: number; unmergedPrCount: number } | null;
  /**
   * Open deliverable rows, for naming which tasks are holding.
   * `waitingOnTaskIds`: unmet `dependsOn` entries of a pending row. Such a row
   * cannot be claimed, so it is never named as the blocker — its dependency is.
   */
  openTasks?: Array<{ id: string; status: string; title?: string | null; waitingOnTaskIds?: string[] }>;
  /** Failed deliverable rows, for naming which tasks failed. */
  failedTasks?: Array<{ id: string; title?: string | null; infra?: boolean }>;
  /**
   * The newest open `claim_loop_deferral` gate row per task in this mission,
   * from `gate_events`. Only rows past `SURFACE_DEFERRAL_MS` become a
   * fact — the threshold lives in `claim-deferral-thresholds.ts` with its
   * justification, so a caller may pass everything it loaded.
   */
  deferrals?: Array<{
    taskId: string;
    reason: string;
    consecutiveDeferrals: number;
    firstDeferredAt?: string | null;
    /** For `path_overlap`: the open PR the claim loop deferred this task behind. */
    blockedByPr?: number | null;
  }>;
  /**
   * The mission's own integration PR, when one is open. `canCompleteMission`
   * knows a mission PR is unmerged but not where it lives; the URL is what
   * turns "waiting on you to merge the mission PR" into an affordance.
   */
  missionPr?: { prNumber: number | null; prUrl: string | null } | null;
  /**
   * Open task PRs, read straight off the worker rows. For a caller that cannot
   * afford a `canCompleteMission` decision per subject — a list page renders
   * dozens — this is the same fact from a cheaper source, and without it a card
   * silently drops the one thing its owner had to do.
   */
  unmergedPrs?: Array<{ taskId: string; title?: string | null; prNumber: number | null; prUrl: string | null }>;
  /**
   * An open fix attempt (taskClass `attempt`) on this subject — the builder a
   * request-changes review or a red CI run queued. While one exists the PR is
   * not ready to merge: the platform owes the next push, not the owner.
   */
  openAttempt?: {
    taskId: string;
    title?: string | null;
    status: string;
    iteration: number | null;
    maxIterations: number | null;
    /** A worker has picked it up (task left `pending`, or a live worker is on it). */
    claimed: boolean;
  } | null;
}

/** The subset of `MissionCompletionDecision` this accessor reads. */
export interface MissionCompletionSummary {
  ok: boolean;
  code: CompletionDecisionCode;
  reason: string;
  pendingDeliverables?: number;
  pendingByStatus?: Record<string, number>;
  infraStalledTitles?: string[];
  awaitingMerge?: number;
  awaitingMergeDetails?: Array<{
    taskId: string;
    title: string;
    prNumber: number | null;
    prUrl: string | null;
    closedUnsuperseded?: boolean;
  }>;
}

// ─── The situation line ───────────────────────────────────────────────────────

/**
 * How outstanding facts are ranked when one of them has to be THE thing on
 * screen. Ordered by who has to act: a failure and an owner decision first,
 * then the things only the owner can clear (merge, a failing criterion), then
 * the things the platform owns (a claim-loop deferral, an open task), then the
 * things that clear themselves.
 *
 * `explain`'s workspace ranking reads this same table, so "what a human should
 * look at first" has one definition across the API and the UI.
 */
export const OUTSTANDING_RANK: Record<WaitingOnDescriptor['kind'], number> = {
  task_failed: 0,
  human_decision: 1,
  dependency: 2,
  merge: 3,
  criterion_failing: 4,
  claim_deferral: 5,
  task: 6,
  criterion_unverified: 7,
  self_resolving_wait: 8,
};

/**
 * The one line a surface renders instead of a row of buttons.
 *
 * Both the mission header and the condensed mission card render `headline`,
 * and neither builds it — that is the whole point of Part 3 of the task this
 * closes. A surface that wants its own phrasing is a surface that will drift.
 */
export interface MissionSituation {
  /** Plain language: what the mission is doing, and what it is waiting on. */
  readonly headline: string;
  readonly tone: WaitingOnTone;
  /**
   * The descriptor `headline` and `nextAction` are about. Null only when
   * nothing at all is outstanding — the honest "nothing to do" case.
   */
  readonly focus: WaitingOnDescriptor | null;
  /** The imperative action that clears `focus`, or null when there is none. */
  readonly nextAction: string | null;
  /** Everything outstanding other than `focus`, in rank order. */
  readonly alsoOutstanding: readonly WaitingOnDescriptor[];
  readonly derivedFrom: MissionStateSource;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(['completed', 'archived']);

function toIso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

function nameCriterion(c: { label?: string; name?: string; type?: string }): string {
  return c.label ?? c.name ?? c.type ?? 'criterion';
}

/**
 * Resolve the mission's state and its blocker, in one pass, from the outputs of
 * the five derivations.
 *
 * The chain below is ordered, first match wins, and every rule states which
 * source it reads and why it outranks the ones under it. That ordering is the
 * entire contract — read it as the specification, not as an implementation
 * detail.
 */
export function deriveMissionStateView(input: MissionStateInput): MissionStateView {
  const resolved = resolve(input);

  const chip = getMissionStateChip(resolved.displayState);
  const criteriaBlockingReason =
    resolved.waitingOn?.kind === 'criterion_failing' || resolved.waitingOn?.kind === 'criterion_unverified'
      ? resolved.waitingOn.label
      : null;

  const outstandingEntries = collectOutstanding(input, resolved);
  const outstanding = outstandingEntries.map(e => e.fact);
  const situation = deriveSituation(input, resolved, outstandingEntries);

  // The brand key is never written — see the note on `MissionStateViewBrand`.
  const base = {
    chip,
    displayState: resolved.displayState,
    criteriaBlockingReason,
    outstanding,
    situation,
    derivedFrom: {
      kind: resolved.source,
      waitingOn: resolved.waitingOn ? resolved.source : null,
      nextAction: resolved.waitingOn ? resolved.source : null,
    },
  };

  if (resolved.waitingOn === null) {
    return {
      ...base,
      kind: resolved.kind as QuietMissionStateKind,
      waitingOn: null,
      nextAction: null,
      // Two-step: the brand is declare-only, so no literal can ever satisfy
      // `MissionStateViewBase` structurally — which is exactly what keeps this
      // function the only producer.
    } as unknown as MissionStateView;
  }

  return {
    ...base,
    kind: resolved.kind as GatedMissionStateKind,
    waitingOn: resolved.waitingOn,
    nextAction: nextActionFor(resolved.waitingOn),
  } as unknown as MissionStateView;
}

interface Resolution {
  kind: MissionStateKind;
  waitingOn: WaitingOnDescriptor | null;
  displayState: MissionDisplayState;
  source: MissionStateSource;
}

function resolve(input: MissionStateInput): Resolution {
  const {
    status, isHeld, activeAgents, health, completion, wait, criteriaGate,
  } = input;

  // 1. The row is closed. Terminal outranks everything: a completed mission's
  //    stale criteria verdict or unmerged sibling PR is history, not a blocker.
  if (TERMINAL_STATUSES.has(status)) {
    return { kind: 'complete', waitingOn: null, displayState: 'complete', source: 'mission.status' };
  }

  // 2. Held — the start gate was never released, so no task in this mission is
  //    claimable. Everything below describes work that cannot begin.
  if (isHeld) {
    return {
      kind: 'held',
      waitingOn: { kind: 'human_decision', tone: 'info', label: 'Held — arm the mission to start work', detail: null },
      displayState: 'held',
      source: 'mission.startMode',
    };
  }

  // 3. Dependency gate. `deriveTaskHealthSignal` returns BLOCKED for an unmet
  //    `dependsOnMissionId`; this outranks `running` deliberately (design doc
  //    Q1) — agents doing parallel work do not clear the gate, and showing
  //    RUNNING hides it.
  if (health === 'BLOCKED' && input.dependsOnMissionId) {
    return {
      kind: 'blocked',
      waitingOn: {
        kind: 'dependency',
        tone: 'warning',
        label: 'Waiting on an upstream mission to meet its gate condition',
        missionId: input.dependsOnMissionId,
      },
      displayState: 'blocked',
      source: 'deriveTaskHealthSignal',
    };
  }

  // 4. The criteria gate escalated to the owner and there is no work left to do.
  //    `hasPendingDeliverableWork === false` is required, not merely absent:
  //    work still moving means the mission is not actually stuck, whatever the
  //    escalation flag says (same rule `deriveMissionHealth` uses).
  if (input.criteriaEscalatedAt && input.hasPendingDeliverableWork === false) {
    return {
      kind: 'awaiting_decision',
      waitingOn: {
        kind: 'human_decision',
        tone: 'warning',
        label: 'Goal criteria escalated — the owner must decide',
        detail: input.escalationDetail ?? null,
      },
      displayState: 'waiting_decision',
      source: 'mission.criteriaEscalatedAt',
    };
  }

  // 5. A live worker is observable ground truth. Everything below this line is
  //    an inference about a mission where nothing is currently executing.
  if (activeAgents > 0) {
    return { kind: 'running', waitingOn: null, displayState: 'running', source: 'workers.live' };
  }

  // 6. A deliverable failed. `infra_stalled` (retries exhausted on
  //    infrastructure, from `canCompleteMission`) is reported as such because
  //    the remedy is different from a task that failed on its merits.
  const failed = failedFact(input);
  if (failed) return failed;

  // 6½. A fix attempt is queued on work that already has a PR. This outranks
  //     the merge rule below: an unmerged PR with a pending builder-after-review
  //     is waiting on the platform's next push, and "waiting on you to merge"
  //     over the top of it sends the owner to merge a PR the reviewer just
  //     rejected. Reached only with no live worker — a claimed fix is `running`
  //     by rule 5, and still named through `outstanding`.
  const attempt = attemptFact(input);
  if (attempt) return attempt;

  // 7. The work is done and has not reached trunk. `canCompleteMission` owns
  //    this refusal (`awaiting_merge` for a task PR, `awaiting_mission_pr` for
  //    the mission's own integration PR); `evaluateMissionWorkState` is the
  //    fallback for a caller that ran only the cheaper predicate. A task's
  //    status is not its terminal state — its PR's state is.
  const merge = mergeFact(input);
  if (merge) return merge;

  // 8. Every open task is on a known self-resolving condition, with a time it
  //    resumes. This outranks the STALLED reading below it — see ruling 2 in
  //    the module note. A benign, explained wait must never render as a stall.
  if (wait) {
    return {
      kind: 'waiting',
      waitingOn: {
        kind: 'self_resolving_wait',
        tone: 'neutral',
        label: `Waiting — ${wait.reason}`,
        reason: wait.reason,
        waitUntil: toIso(wait.waitUntil),
      },
      displayState: 'active',
      source: 'classifyMissionWait',
    };
  }
  // `deriveTaskHealthSignal` folds an in-flight heartbeat wait into BLOCKED
  // (`heartbeatWaitingUntil` in the future). Without a wait-until from
  // `classifyMissionWait` the reason is unknown, but "it is waiting" is still
  // the honest answer, and it is not a stall.
  if (health === 'BLOCKED') {
    return {
      kind: 'waiting',
      waitingOn: {
        kind: 'self_resolving_wait',
        tone: 'neutral',
        label: 'Waiting — the heartbeat is deliberately holding this cycle',
        reason: 'heartbeat wait',
        waitUntil: null,
      },
      displayState: 'active',
      source: 'deriveTaskHealthSignal',
    };
  }

  // 9. Open deliverable rows with nothing live on them, and no wait explaining
  //    it. This is the genuine stall, and the only task-level `blocked`.
  const open = openTaskFact(input, false);
  if (open) return open;

  // 10. The work is done and the completion gate has not cleared. NEVER
  //     `blocked` — see ruling 1 in the module note. Tone comes straight from
  //     `deriveCriteriaGatePresentation`, so an unverified criterion on a
  //     mission nothing has tried to close stays neutral.
  const criteria = criteriaFact(input);
  if (criteria) return criteria;

  // 11. Nothing is running, nothing failed, nothing is open, no PR is waiting,
  //     no criterion is holding. Reached only after every source that could
  //     contradict it has been consulted — which is what makes `waitingOn:
  //     null` here a claim rather than a default.
  if (input.orchestrationMode === 'manual') {
    return { kind: 'idle', waitingOn: null, displayState: 'manual', source: 'mission.status' };
  }
  return {
    kind: 'idle',
    waitingOn: null,
    displayState: input.progress !== undefined && input.progress >= 100 ? 'review' : 'active',
    source: 'mission.status',
  };
}

// ─── Fact builders ────────────────────────────────────────────────────────────
//
// Each one answers "is THIS true about the mission?" from the sources that own
// it. `resolve` calls them in precedence order and stops at the first hit;
// `collectOutstanding` calls the same functions and keeps every hit. Two
// callers, one definition per fact — the alternative is a second place where a
// merge or a criterion gets described, which is the drift this module exists
// to prevent.

/** Rule 6 — a deliverable failed, on its merits or on infrastructure. */
function failedFact(input: MissionStateInput): Resolution | null {
  const { completion } = input;
  const infraTitles = completion?.code === 'infra_stalled' ? completion.infraStalledTitles ?? [] : [];
  if (infraTitles.length > 0) {
    return {
      kind: 'failing',
      waitingOn: {
        kind: 'task_failed',
        tone: 'error',
        label: `${infraTitles.length} task(s) failed on infrastructure and need manual intervention`,
        infra: true,
        taskIds: (input.failedTasks ?? []).filter(t => t.infra).map(t => t.id),
        titles: infraTitles,
      },
      displayState: 'failed',
      source: 'canCompleteMission',
    };
  }
  if (input.health === 'FAILING') {
    const failed = input.failedTasks ?? [];
    return {
      kind: 'failing',
      waitingOn: {
        kind: 'task_failed',
        tone: 'error',
        label: failed.length === 1
          ? `A deliverable task failed: ${failed[0].title ?? failed[0].id}`
          : `${failed.length || 'One or more'} deliverable task(s) failed`,
        infra: false,
        taskIds: failed.map(t => t.id),
        titles: failed.map(t => t.title ?? t.id),
      },
      displayState: 'failed',
      source: 'deriveTaskHealthSignal',
    };
  }
  return null;
}

/** Rule 6½ — a fix attempt is open on work that already has a PR. */
function attemptFact(input: MissionStateInput): Resolution | null {
  const a = input.openAttempt;
  if (!a) return null;
  return {
    kind: 'waiting',
    waitingOn: {
      kind: 'task',
      tone: 'neutral',
      label: `${fixLabel(a)} ${a.claimed ? 'in progress' : 'queued — no worker yet'}`,
      count: 1,
      taskIds: [a.taskId],
      byStatus: { [a.status]: 1 },
      attempt: { iteration: a.iteration, maxIterations: a.maxIterations, claimed: a.claimed },
    },
    displayState: 'active',
    source: 'tasks.parentTaskId + tasks.taskClass',
  };
}

function fixLabel(a: { iteration: number | null; maxIterations: number | null }): string {
  if (a.iteration == null) return 'Fix';
  return a.maxIterations != null ? `Fix ${a.iteration} of ${a.maxIterations}` : `Fix ${a.iteration}`;
}

/** Rule 7 — the work is done and has not reached trunk. */
function mergeFact(input: MissionStateInput): Resolution | null {
  // An open fix attempt means the PR is about to change; asking the owner to
  // merge it now is the false headline rule 6½ exists to prevent.
  if (input.openAttempt) return null;
  const { completion } = input;
  if (completion && isMergeBlockCode(completion.code)) {
    const details = completion.awaitingMergeDetails ?? [];
    const missionPr = completion.code === 'awaiting_mission_pr';
    // `canCompleteMission` knows the mission PR is unmerged without knowing
    // where it is; the caller passes `missionPr` when it loaded the row, and
    // that is the difference between a sentence and a link.
    const prNumbers = missionPr && input.missionPr?.prNumber != null
      ? [input.missionPr.prNumber]
      : details.map(d => d.prNumber).filter((n): n is number => typeof n === 'number');
    const prUrls = missionPr && input.missionPr?.prUrl
      ? [input.missionPr.prUrl]
      : details.map(d => d.prUrl).filter((u): u is string => typeof u === 'string');
    return {
      kind: 'awaiting_merge',
      waitingOn: {
        kind: 'merge',
        tone: 'warning',
        label: missionPr
          ? 'The mission PR has not merged — the work is not on trunk'
          : `${completion.awaitingMerge ?? details.length} completed task(s) have an unmerged PR`,
        count: completion.awaitingMerge ?? details.length,
        prNumbers,
        prUrls,
        taskIds: details.map(d => d.taskId),
        missionPr,
      },
      displayState: 'review',
      source: 'canCompleteMission',
    };
  }
  if (input.workState && input.workState.reason === 'prs_unmerged') {
    return {
      kind: 'awaiting_merge',
      waitingOn: {
        kind: 'merge',
        tone: 'warning',
        label: `${input.workState.unmergedPrCount} deliverable PR(s) have not merged`,
        count: input.workState.unmergedPrCount,
        prNumbers: [],
        prUrls: [],
        taskIds: [],
        missionPr: false,
      },
      displayState: 'review',
      source: 'evaluateMissionWorkState',
    };
  }
  // Rows only. A caller with no completion decision and no work-state
  // evaluation still holds the task + worker rows that prove a PR is open. Same
  // fact, cheaper source — and it is the difference between a mission card that
  // says "waiting on you to merge the mission PR" and one that says nothing.
  const openMissionPr = input.missionPr && (input.missionPr.prNumber != null || input.missionPr.prUrl)
    ? input.missionPr
    : null;
  const rowPrs = input.unmergedPrs ?? [];
  if (openMissionPr || rowPrs.length > 0) {
    const missionPr = openMissionPr !== null;
    return {
      kind: 'awaiting_merge',
      waitingOn: {
        kind: 'merge',
        tone: 'warning',
        label: missionPr
          ? 'The mission PR has not merged — the work is not on trunk'
          : `${rowPrs.length} completed task(s) have an unmerged PR`,
        count: missionPr ? 1 : rowPrs.length,
        prNumbers: missionPr
          ? openMissionPr!.prNumber != null ? [openMissionPr!.prNumber] : []
          : rowPrs.map(p => p.prNumber).filter((n): n is number => typeof n === 'number'),
        prUrls: missionPr
          ? openMissionPr!.prUrl ? [openMissionPr!.prUrl] : []
          : rowPrs.map(p => p.prUrl).filter((u): u is string => typeof u === 'string'),
        taskIds: missionPr ? [] : rowPrs.map(p => p.taskId),
        missionPr,
      },
      displayState: 'review',
      source: 'workers.prUrl + workers.mergedAt',
    };
  }
  return null;
}

/**
 * Rule 9 — open deliverable rows.
 *
 * `live` changes what can honestly be claimed, not whether the fact exists. With
 * nothing executing these tasks are a STALL, which is the only task-level
 * `blocked`; with a worker running they are simply not finished yet, which is
 * still something the header owes the reader and is deliberately quiet.
 */
function openTaskFact(input: MissionStateInput, live: boolean): Resolution | null {
  const { completion } = input;
  const openTasks = input.openTasks ?? [];
  const pendingCount = completion?.pendingDeliverables ?? openTasks.length;
  const qualifies = live
    ? pendingCount > 0
    : input.health === 'STALLED' || (completion?.code === 'pending_deliverables' && pendingCount > 0);
  if (!qualifies) return null;

  const byStatus = completion?.pendingByStatus
    ?? openTasks.reduce<Record<string, number>>((acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1;
      return acc;
    }, {});
  const breakdown = Object.entries(byStatus).map(([s, n]) => `${n} ${s}`).join(', ');

  // Never cite a row that is only waiting on its dependency: it cannot be
  // claimed, so it is not what is holding the mission. Claimable rows lead;
  // when there are none, the unmet dependencies are the honest answer, and
  // the reading is a wait on the DAG rather than a stall.
  const claimable = openTasks.filter(t => !(t.waitingOnTaskIds?.length));
  const depOnly = !live && openTasks.length > 0 && claimable.length === 0;
  if (depOnly) {
    const depIds = [...new Set(openTasks.flatMap(t => t.waitingOnTaskIds ?? []))];
    return {
      kind: 'waiting',
      waitingOn: {
        kind: 'task',
        tone: 'neutral',
        label: `${pendingCount} task(s) waiting on ${depIds.length === 1 ? 'an unmet dependency' : `${depIds.length} unmet dependencies`}`,
        count: pendingCount,
        taskIds: depIds,
        byStatus,
      },
      displayState: 'active',
      source: completion?.code === 'pending_deliverables' ? 'canCompleteMission' : 'deriveTaskHealthSignal',
    };
  }
  const citedIds = (live ? openTasks : claimable).map(t => t.id);

  return {
    kind: live ? 'running' : 'blocked',
    waitingOn: {
      kind: 'task',
      tone: live ? 'neutral' : 'warning',
      label: live
        ? breakdown
          ? `${pendingCount} deliverable task(s) still open (${breakdown})`
          : `${pendingCount} deliverable task(s) still open`
        : breakdown
          ? `${pendingCount} task(s) open with no live worker (${breakdown})`
          : `${pendingCount} task(s) open with no live worker`,
      count: pendingCount,
      taskIds: citedIds,
      byStatus,
    },
    displayState: live ? 'running' : 'stalled',
    source: completion?.code === 'pending_deliverables' ? 'canCompleteMission' : 'deriveTaskHealthSignal',
  };
}

const OPEN_STATUS_LABEL: Record<string, string> = {
  pending: 'queued',
  assigned: 'claimed',
  in_progress: 'running',
};

/**
 * What holds each failing structural criterion, read from the rows this view
 * was given — never from the stored evidence, which is as old as the run.
 *
 * - `no_open_tasks`: the open deliverables, minus the `[surface audit]` check
 *   (the evaluator's own rule, `isNoOpenTasksCandidate`; `openTasks` are
 *   already deliverables).
 * - `all_prs_merged`: the unmerged task PRs.
 *
 * `stale`: every failing criterion is `no_open_tasks`, the caller loaded the
 * open rows, and there are none. The verdict predates the task state.
 */
function criterionBlockers(
  input: MissionStateInput,
  failingItems: ReadonlyArray<{ type?: string }>,
): { blockers: CriterionBlocker[]; stale: boolean } {
  const types = new Set(failingItems.map(c => c.type));
  const out: CriterionBlocker[] = [];
  const seen = new Set<string>();
  const push = (b: CriterionBlocker) => {
    if (seen.has(b.taskId)) return;
    seen.add(b.taskId);
    out.push(b);
  };

  let openBlockers = 0;
  if (types.has('no_open_tasks')) {
    for (const t of input.openTasks ?? []) {
      if (isSurfaceAuditTask(t.title ?? '')) continue;
      openBlockers++;
      push({ taskId: t.id, title: t.title ?? t.id, status: OPEN_STATUS_LABEL[t.status] ?? t.status.replace(/_/g, ' ') });
    }
  }
  if (types.has('all_prs_merged')) {
    const prs = input.completion?.awaitingMergeDetails?.length
      ? input.completion.awaitingMergeDetails
      : input.unmergedPrs ?? [];
    for (const p of prs) {
      push({ taskId: p.taskId, title: p.title ?? p.taskId, status: p.prNumber != null ? `PR #${p.prNumber} open` : 'PR open' });
    }
  }

  const stale = failingItems.length > 0
    && failingItems.every(c => c.type === 'no_open_tasks')
    && input.openTasks !== undefined
    && openBlockers === 0;
  return { blockers: out, stale };
}

/** Rule 10 — the completion gate has not cleared. Never `blocked`. */
function criteriaFact(input: MissionStateInput): Resolution | null {
  const { criteriaGate, completion } = input;
  if (criteriaGate && criteriaGate.state !== 'clear') {
    const items = input.criteriaItems ?? [];
    const failing = items.filter(c => c.verdict === 'fail').map(nameCriterion);
    const nonPass = items.filter(c => c.verdict !== 'pass').map(nameCriterion);
    const refused = criteriaGate.state === 'refused';

    if (criteriaGate.state === 'failing' || failing.length > 0 || (refused && completion?.code === 'criteria_failed')) {
      const count = failing.length || 1;
      const { blockers, stale } = criterionBlockers(input, items.filter(c => c.verdict === 'fail'));
      return {
        kind: 'awaiting_verification',
        waitingOn: {
          kind: 'criterion_failing',
          tone: refused ? 'error' : 'warning',
          label: count === 1
            ? `Criterion failing: ${failing[0] ?? criteriaGate.detail ?? 'criterion'}`
            : `${count} criteria failing`,
          count,
          criteria: failing,
          refused,
          ...(blockers.length > 0 ? { blockers } : {}),
          ...(stale ? { stale } : {}),
        },
        displayState: 'awaiting_verification',
        source: 'deriveCriteriaGatePresentation',
      };
    }

    const count = nonPass.length || 1;
    const awaitingRunner = items
      .filter(c => c.verdict !== 'pass' && c.awaitingRunner === true)
      .map(nameCriterion);
    if (awaitingRunner.length > 0) {
      return {
        kind: 'awaiting_verification',
        waitingOn: {
          kind: 'criterion_unverified',
          // Not quiet: a verification task nobody claims never resolves itself.
          tone: 'warning',
          label: awaitingRunner.length === 1
            ? `Waiting for a runner to verify "${awaitingRunner[0]}"`
            : `Waiting for a runner to verify ${awaitingRunner.length} criteria`,
          count,
          criteria: nonPass,
          awaitingRunner,
        },
        displayState: 'awaiting_verification',
        source: 'deriveCriteriaGatePresentation',
      };
    }
    return {
      kind: 'awaiting_verification',
      waitingOn: {
        kind: 'criterion_unverified',
        // Quiet by construction. `refused` means completion was actually
        // attempted and held — only then is a missing verdict newsworthy.
        tone: refused ? 'warning' : 'neutral',
        label: count === 1
          ? '1 criterion not yet verified — run verification'
          : `${count} criteria not yet verified — run verification`,
        count,
        criteria: nonPass,
      },
      displayState: 'awaiting_verification',
      source: 'deriveCriteriaGatePresentation',
    };
  }
  // A criteria refusal with no gate presentation supplied (a caller that ran
  // `canCompleteMission` but not `deriveCriteriaGatePresentation`) still has to
  // produce the same answer, not fall through to idle.
  if (completion && isCriteriaBlockCode(completion.code)) {
    const failing = completion.code === 'criteria_failed';
    return {
      kind: 'awaiting_verification',
      waitingOn: failing
        ? { kind: 'criterion_failing', tone: 'warning', label: 'Goal criteria failed', count: 1, criteria: [], refused: true }
        : { kind: 'criterion_unverified', tone: 'neutral', label: 'Goal criteria not yet verified — run verification', count: 1, criteria: [] },
      displayState: 'awaiting_verification',
      source: 'canCompleteMission',
    };
  }
  return null;
}

/**
 * The claim loop has refused the same task, for the same reason, enough
 * consecutive polls to stop being contention.
 *
 * Deliberately NOT part of `resolve`'s precedence chain: a deferral says
 * nothing about what state the mission is in — it says the state on screen is
 * not the whole story. It is reported through `outstanding`, which is exactly
 * the case the observed bug produced: a spinner reading "1 agent active" over
 * a task the claim loop had turned away a dozen times running.
 */
/** The gate reason, plus the PR it waits on when the ledger named one. */
function deferralReasonText(d: { reason: string; blockedByPr?: number | null }): string {
  return typeof d.blockedByPr === 'number' ? `${d.reason} — blocked by PR #${d.blockedByPr}` : d.reason;
}

function deferralFact(input: MissionStateInput): WaitingOnDescriptor | null {
  const stuck = (input.deferrals ?? []).filter(d => isRepeatedlyDeferred(d.consecutiveDeferrals, d.firstDeferredAt));
  if (stuck.length === 0) return null;
  // Worst offender leads: it is the one with the longest unbroken refusal.
  const worst = stuck.reduce((a, b) => (b.consecutiveDeferrals > a.consecutiveDeferrals ? b : a));
  const reason = deferralReasonText(worst);
  return {
    kind: 'claim_deferral',
    tone: 'warning',
    label: stuck.length === 1
      ? `A task has been deferred by the claim loop ${worst.consecutiveDeferrals} times in a row — reason: ${reason}`
      : `${stuck.length} tasks are being deferred by the claim loop (worst: ${worst.consecutiveDeferrals} in a row — ${reason})`,
    count: stuck.length,
    reason: worst.reason,
    consecutiveDeferrals: worst.consecutiveDeferrals,
    firstDeferredAt: worst.firstDeferredAt ?? null,
    blockedByPr: worst.blockedByPr ?? null,
    taskIds: stuck.map(d => d.taskId),
  };
}

// ─── Outstanding facts ────────────────────────────────────────────────────────

/**
 * Every fact that is outstanding, ranked, regardless of which won precedence.
 *
 * Terminal missions report nothing: a completed mission's stale criteria
 * verdict is history, and rule 1 already said so.
 *
 * The one subtraction is deliberate. A `self_resolving_wait` and a STALLED
 * open-task reading both assert that NOTHING IS EXECUTING. A live worker
 * refutes them outright, so with `activeAgents > 0` the open-task fact is
 * rebuilt in its honest form ("still open") and the wait is dropped rather than
 * demoted. Everything else — an unmerged PR, an unmet criterion, a failed
 * deliverable, a dependency, an owner decision, a claim-loop deferral — stays
 * true no matter what is running, and is reported.
 */
interface OutstandingEntry {
  fact: WaitingOnDescriptor;
  /** Which derivation produced THIS fact — not which produced the verdict. */
  source: MissionStateSource;
}

function collectOutstanding(input: MissionStateInput, resolved: Resolution): OutstandingEntry[] {
  if (resolved.kind === 'complete') return [];

  const live = input.activeAgents > 0;
  const candidates: Array<OutstandingEntry | null> = [
    resolved.waitingOn ? { fact: resolved.waitingOn, source: resolved.source } : null,
    entry(deferralFact(input), 'gateEvents.claimLoopDeferral'),
    fromResolution(failedFact(input)),
    fromResolution(attemptFact(input)),
    fromResolution(mergeFact(input)),
    fromResolution(criteriaFact(input)),
    fromResolution(openTaskFact(input, live)),
  ];

  const seen = new Set<WaitingOnDescriptor['kind']>();
  const out: OutstandingEntry[] = [];
  for (const c of candidates) {
    if (!c) continue;
    // A wait and a stall both claim nothing is executing. Held/idle missions
    // keep them; a running one would be publishing a contradiction.
    if (live && c.fact.kind === 'self_resolving_wait') continue;
    if (seen.has(c.fact.kind)) continue;
    seen.add(c.fact.kind);
    out.push(c);
  }
  return out.sort((a, b) => OUTSTANDING_RANK[a.fact.kind] - OUTSTANDING_RANK[b.fact.kind]);
}

function entry(fact: WaitingOnDescriptor | null, source: MissionStateSource): OutstandingEntry | null {
  return fact ? { fact, source } : null;
}

function fromResolution(r: Resolution | null): OutstandingEntry | null {
  return r && r.waitingOn ? { fact: r.waitingOn, source: r.source } : null;
}

// ─── The situation line ───────────────────────────────────────────────────────

/**
 * Plain language for one blocker, phrased from the reader's side of the screen:
 * "waiting on you to …" when the owner is the only one who can clear it,
 * a statement of fact when they are not.
 */
function situationPhrase(d: WaitingOnDescriptor, opts: { running?: boolean } = {}): string {
  switch (d.kind) {
    case 'dependency':
      return 'waiting on an upstream mission to meet its gate condition';
    case 'task':
      if (d.attempt) {
        const fix = fixLabel(d.attempt).toLowerCase();
        return d.attempt.claimed ? `waiting on ${fix} (in progress)` : `waiting on ${fix} (queued — no worker yet)`;
      }
      return d.count === 1 ? '1 task is still open' : `${d.count} tasks are still open`;
    case 'task_failed':
      return d.infra
        ? d.titles.length === 1
          ? '1 task failed on infrastructure and needs manual intervention'
          : `${d.titles.length} tasks failed on infrastructure and need manual intervention`
        : d.titles.length === 1
          ? `a task failed: ${d.titles[0]}`
          : `${d.titles.length || 'one or more'} tasks failed`;
    case 'merge': {
      const ref = d.prNumbers.length === 1 ? ` #${d.prNumbers[0]}` : '';
      return d.missionPr
        ? `waiting on you to merge the mission PR${ref}`
        : d.count === 1
          ? `waiting on you to merge 1 open PR${ref}`
          : `waiting on you to merge ${d.count} open PRs`;
    }
    case 'criterion_failing': {
      const named = d.count === 1 && d.criteria[0] ? `"${d.criteria[0]}"` : `${d.count} goal criteria`;
      if (d.stale) {
        return `waiting on you to re-run verification — ${named} failed when last checked, but no task is open now`;
      }
      // While work is in flight a failing criterion is the work not being
      // finished yet, not an ask (`missionNeedsYou`), so it is stated as fact.
      const ask = opts.running ? '' : 'waiting on you — ';
      const n = d.blockers?.length ?? 0;
      if (n > 0) {
        return `${ask}${named} ${d.count === 1 ? 'is' : 'are'} failing on ${n === 1 ? '1 task' : `${n} tasks`}`;
      }
      return d.count === 1 && d.criteria[0]
        ? `${ask}the goal criterion "${d.criteria[0]}" is failing`
        : `${ask}${d.count} goal criteria are failing`;
    }
    case 'criterion_unverified':
      if (d.awaitingRunner && d.awaitingRunner.length > 0) {
        return d.awaitingRunner.length === 1
          ? `waiting for a runner to verify "${d.awaitingRunner[0]}"`
          : `waiting for a runner to verify ${d.awaitingRunner.length} goal criteria`;
      }
      return d.count === 1
        ? 'waiting on goal-criteria verification — 1 criterion has no verdict yet'
        : `waiting on goal-criteria verification — ${d.count} criteria have no verdict yet`;
    case 'human_decision':
      // These labels already read as statements ("Held — arm the mission to
      // start work"), so they are quoted, not re-worded.
      return `waiting on you: ${d.label}`;
    case 'self_resolving_wait':
      return d.waitUntil
        ? `waiting on ${d.reason} — resumes on its own at ${d.waitUntil}`
        : `waiting on ${d.reason} — resumes on its own`;
    case 'claim_deferral':
      return d.count === 1
        ? `an agent has been turned away by the claim loop ${d.consecutiveDeferrals} times in a row — ${deferralReasonText(d)}`
        : `${d.count} agents are being turned away by the claim loop — worst: ${d.consecutiveDeferrals} in a row, ${deferralReasonText(d)}`;
  }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/**
 * Build the one line the header and the card both render.
 *
 * The shape is `<what the mission is doing> — <what it is waiting on>`. When
 * both halves are true they are BOTH said, joined by "but": "Running (1 agent)
 * — but waiting on you to merge the mission PR" is the sentence the observed
 * screen could not produce, and the reason it could not is that it only ever
 * read the precedence verdict.
 */
function deriveSituation(
  input: MissionStateInput,
  resolved: Resolution,
  outstanding: readonly OutstandingEntry[],
): MissionSituation {
  const lead = outstanding[0] ?? null;
  const focus = lead?.fact ?? null;
  const alsoOutstanding = outstanding.slice(1).map(e => e.fact);

  if (resolved.kind === 'complete') {
    return {
      headline: 'Complete — nothing outstanding.',
      tone: 'neutral',
      focus: null,
      nextAction: null,
      alsoOutstanding: [],
      derivedFrom: resolved.source,
    };
  }

  if (!focus || !lead) {
    // Every source that could contradict this was consulted and had nothing to
    // say. Say THAT, rather than falling back to a row of buttons.
    const headline = resolved.kind === 'running'
      ? `Running — ${countAgents(input.activeAgents)} in flight, nothing outstanding.`
      : 'Nothing to do — no source reports anything outstanding.';
    return {
      headline,
      tone: 'neutral',
      focus: null,
      nextAction: null,
      alsoOutstanding: [],
      derivedFrom: resolved.source,
    };
  }

  const phrase = situationPhrase(focus, { running: resolved.kind === 'running' });
  const headline = resolved.kind === 'running'
    ? `Running (${countAgents(input.activeAgents)}) — but ${phrase}.`
    : `${capitalize(phrase)}.`;

  return {
    headline,
    tone: focus.tone,
    focus,
    nextAction: nextActionFor(focus),
    alsoOutstanding,
    derivedFrom: lead.source,
  };
}

function countAgents(n: number): string {
  return n === 1 ? '1 agent' : `${n} agents`;
}

/**
 * What would unblock it. One sentence, imperative, derived from the descriptor
 * — never null on a gated view, because "gated with no way out" is not a state
 * this system is allowed to report.
 */
export function nextActionFor(waitingOn: WaitingOnDescriptor): string {
  switch (waitingOn.kind) {
    case 'dependency':
      return 'Complete the upstream mission, or clear the dependency gate on this one.';
    case 'task':
      if (waitingOn.attempt) {
        return waitingOn.attempt.claimed
          ? 'Nothing to do yet — the fix is in progress; review runs again after it pushes.'
          : 'Nothing to do yet — the fix is queued for the next free worker. Cancel it if the work is no longer wanted.';
      }
      return 'Dispatch a worker for the open task(s), or cancel them if the work is no longer wanted.';
    case 'task_failed':
      return waitingOn.infra
        ? 'Investigate the infrastructure failure and re-run the task; retries are already exhausted.'
        : 'Read the failure and either retry the task or change its scope.';
    case 'merge':
      return waitingOn.missionPr
        ? 'Land the mission PR — the work is on the integration branch, not on trunk.'
        : 'Resolve and merge the open PR(s); a completed task with an unmerged PR has not shipped.';
    case 'criterion_failing':
      if (waitingOn.stale) {
        return 'Re-run goal-criteria verification: the failing verdict predates the current task state.';
      }
      if (waitingOn.blockers && waitingOn.blockers.length > 0) {
        return 'Finish, cancel or merge the tasks holding it, then re-run verification.';
      }
      return 'File work against the failing criterion, or correct the criterion if it no longer describes the goal.';
    case 'criterion_unverified':
      if (waitingOn.awaitingRunner && waitingOn.awaitingRunner.length > 0) {
        return 'Start or free up a runner for this workspace — the verification task is queued with none to claim it.';
      }
      return 'Run goal-criteria verification to produce a verdict.';
    case 'human_decision':
      return 'An owner decision is required; nothing automated will move this.';
    case 'self_resolving_wait':
      return waitingOn.waitUntil
        ? `Nothing to do — this resumes on its own at ${waitingOn.waitUntil}.`
        : 'Nothing to do — this resumes on its own.';
    case 'claim_deferral':
      return `The claim loop is refusing this task (${deferralReasonText(waitingOn)}) — clear that gate, or cancel the task if the work is no longer wanted.`;
  }
}

// ─── Whose move is it? ────────────────────────────────────────────────────────

/** Verdicts whose next step is the owner's, whatever the mission's health says. */
const NEEDS_YOU_KINDS: ReadonlySet<MissionStateKind> = new Set([
  'awaiting_merge',
  'awaiting_verification',
  'awaiting_decision',
  'failing',
]);

/**
 * Facts that are the owner's to clear even when they did not win precedence
 * (a live worker, a hold). A criterion fact is NOT one of them: while work is
 * still moving, a failing "no open tasks" is the work not being finished yet,
 * not an ask. With nothing moving, `missionNeedsYou` reads it off the
 * situation's focus instead.
 */
const OWNER_FACT_KINDS: ReadonlySet<WaitingOnDescriptor['kind']> = new Set([
  'merge',
  'task_failed',
  'human_decision',
]);

/**
 * True when the mission's next step is the owner's (F1). The one input the
 * mission grouping reads to put a mission under "active" — list header, list
 * groups and Home — so a card whose chip asks you for something is never filed
 * under PAUSED / HELD or SCHEDULED.
 *
 * A held mission's own ask ("arm it") does not count: arming is a start, not an
 * answer (§1.1). Anything else it is waiting on you for does.
 */
export function missionNeedsYou(view: MissionStateView): boolean {
  if (view.kind === 'complete') return false;
  if (NEEDS_YOU_KINDS.has(view.kind)) return true;
  const holdAsk = view.kind === 'held' ? view.waitingOn : null;
  if (view.outstanding.some(f => f !== holdAsk && OWNER_FACT_KINDS.has(f.kind))) return true;
  // needsYou follows the situation. With no work in flight (not `running`) and
  // no hold, a failing criterion the headline leads with is the owner's to
  // clear, even when it did not win precedence: a paused mission whose open
  // tasks stalled resolves to `blocked` (STALLED) yet reads "Waiting on you —
  // "no open tasks" is failing on 2 tasks". Nothing automated moves it.
  return view.kind !== 'running' && view.kind !== 'held' && view.situation.focus?.kind === 'criterion_failing';
}

// ─── The situation's one explanatory line ─────────────────────────────────────

/**
 * What the situation block prints under its headline — exactly one line, so
 * the same fact is not said three times (headline, causal claim, criterion ref).
 *
 * - The focus names blockers → the blockers (the first
 *   `CRITERION_BLOCKERS_VISIBLE`, then "+N more").
 * - The focus is a criterion → its next action. The causal claim ("criterion X
 *   returned a failing verdict") only restates the headline.
 * - Anything else → the first causal link, whose hard ref is the evidence.
 */
export type SituationDetail<L> =
  | { kind: 'blockers'; items: CriterionBlocker[]; more: number }
  | { kind: 'text'; text: string }
  | { kind: 'why'; link: L };

export function situationDetail<L>(situation: MissionSituation, because: readonly L[]): SituationDetail<L> | null {
  const focus = situation.focus;
  if (focus?.kind === 'criterion_failing' && focus.blockers && focus.blockers.length > 0) {
    return {
      kind: 'blockers',
      items: focus.blockers.slice(0, CRITERION_BLOCKERS_VISIBLE),
      more: Math.max(0, focus.blockers.length - CRITERION_BLOCKERS_VISIBLE),
    };
  }
  if (focus?.kind === 'criterion_failing' || focus?.kind === 'criterion_unverified') {
    return situation.nextAction ? { kind: 'text', text: situation.nextAction } : null;
  }
  return because[0] !== undefined ? { kind: 'why', link: because[0] } : null;
}

/** Exported for the threshold's own regression test and for surfaces that explain it. */
export { SURFACE_DEFERRAL_MS };
