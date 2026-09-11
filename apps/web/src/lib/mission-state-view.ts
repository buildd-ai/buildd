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
 */
import type { CriteriaGatePresentation } from '@buildd/core/mission-helpers';
import type { CompletionDecisionCode } from '@buildd/core/mission-completion-codes';
import { isCriteriaBlockCode, isMergeBlockCode } from '@buildd/core/mission-completion-codes';
import type { Health, MissionDisplayState } from './mission-helpers';
import { getMissionStateChip } from './mission-helpers';

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
  | 'evaluateMissionWorkState';

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
      taskIds: string[];
      /** True when the unmerged PR is the mission's own integration PR, not a task PR. */
      missionPr: boolean;
    }
  /** The completion gate is holding on a criterion that failed. */
  | { kind: 'criterion_failing'; tone: WaitingOnTone; label: string; count: number; criteria: string[]; refused: boolean }
  /** The completion gate has no verdict yet. Quiet by construction — see the module note. */
  | { kind: 'criterion_unverified'; tone: WaitingOnTone; label: string; count: number; criteria: string[] }
  /** A human owes an answer; nothing automated will move this. */
  | { kind: 'human_decision'; tone: WaitingOnTone; label: string; detail: string | null }
  /**
   * Everything open is on a known self-resolving condition. Resumes by itself.
   * `waitUntil` is null when the wait is known but its resume time is not —
   * an empty string would read as a timestamp nobody can parse.
   */
  | { kind: 'self_resolving_wait'; tone: WaitingOnTone; label: string; reason: string; waitUntil: string | null };

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
  criteriaItems?: Array<{ verdict: string; label?: string; name?: string; type?: string }>;
  /** From `canCompleteMission`, when a caller ran it. */
  completion?: MissionCompletionSummary | null;
  /** From `classifyMissionWait`, when a caller ran it. */
  wait?: { reason: string; waitUntil: Date | string } | null;
  /** From `evaluateMissionWorkState`, when a caller ran it. */
  workState?: { complete: boolean; reason: string; unfinishedTaskCount: number; unmergedPrCount: number } | null;
  /** Open deliverable rows, for naming which tasks are holding. */
  openTasks?: Array<{ id: string; status: string; title?: string | null }>;
  /** Failed deliverable rows, for naming which tasks failed. */
  failedTasks?: Array<{ id: string; title?: string | null; infra?: boolean }>;
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
  awaitingMergeDetails?: Array<{ taskId: string; title: string; prNumber: number | null; prUrl: string | null }>;
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

  // The brand key is never written — see the note on `MissionStateViewBrand`.
  const base = {
    chip,
    displayState: resolved.displayState,
    criteriaBlockingReason,
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
    } as MissionStateView;
  }

  return {
    ...base,
    kind: resolved.kind as GatedMissionStateKind,
    waitingOn: resolved.waitingOn,
    nextAction: nextActionFor(resolved.waitingOn),
  } as MissionStateView;
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
  if (health === 'FAILING') {
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

  // 7. The work is done and has not reached trunk. `canCompleteMission` owns
  //    this refusal (`awaiting_merge` for a task PR, `awaiting_mission_pr` for
  //    the mission's own integration PR); `evaluateMissionWorkState` is the
  //    fallback for a caller that ran only the cheaper predicate. A task's
  //    status is not its terminal state — its PR's state is.
  if (completion && isMergeBlockCode(completion.code)) {
    const details = completion.awaitingMergeDetails ?? [];
    const missionPr = completion.code === 'awaiting_mission_pr';
    return {
      kind: 'awaiting_merge',
      waitingOn: {
        kind: 'merge',
        tone: 'warning',
        label: missionPr
          ? 'The mission PR has not merged — the work is not on trunk'
          : `${completion.awaitingMerge ?? details.length} completed task(s) have an unmerged PR`,
        count: completion.awaitingMerge ?? details.length,
        prNumbers: details.map(d => d.prNumber).filter((n): n is number => typeof n === 'number'),
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
        taskIds: [],
        missionPr: false,
      },
      displayState: 'review',
      source: 'evaluateMissionWorkState',
    };
  }

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
  const openTasks = input.openTasks ?? [];
  const pendingCount = completion?.pendingDeliverables ?? openTasks.length;
  if (health === 'STALLED' || (completion?.code === 'pending_deliverables' && pendingCount > 0)) {
    const byStatus = completion?.pendingByStatus
      ?? openTasks.reduce<Record<string, number>>((acc, t) => {
        acc[t.status] = (acc[t.status] ?? 0) + 1;
        return acc;
      }, {});
    const breakdown = Object.entries(byStatus).map(([s, n]) => `${n} ${s}`).join(', ');
    return {
      kind: 'blocked',
      waitingOn: {
        kind: 'task',
        tone: 'warning',
        label: breakdown
          ? `${pendingCount} task(s) open with no live worker (${breakdown})`
          : `${pendingCount} task(s) open with no live worker`,
        count: pendingCount,
        taskIds: openTasks.map(t => t.id),
        byStatus,
      },
      displayState: 'stalled',
      source: completion?.code === 'pending_deliverables' ? 'canCompleteMission' : 'deriveTaskHealthSignal',
    };
  }

  // 10. The work is done and the completion gate has not cleared. NEVER
  //     `blocked` — see ruling 1 in the module note. Tone comes straight from
  //     `deriveCriteriaGatePresentation`, so an unverified criterion on a
  //     mission nothing has tried to close stays neutral.
  if (criteriaGate && criteriaGate.state !== 'clear') {
    const items = input.criteriaItems ?? [];
    const failing = items.filter(c => c.verdict === 'fail').map(nameCriterion);
    const nonPass = items.filter(c => c.verdict !== 'pass').map(nameCriterion);
    const refused = criteriaGate.state === 'refused';

    if (criteriaGate.state === 'failing' || failing.length > 0 || (refused && completion?.code === 'criteria_failed')) {
      const count = failing.length || 1;
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
        },
        displayState: 'awaiting_verification',
        source: 'deriveCriteriaGatePresentation',
      };
    }

    const count = nonPass.length || 1;
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
      return 'File work against the failing criterion, or correct the criterion if it no longer describes the goal.';
    case 'criterion_unverified':
      return 'Run goal-criteria verification to produce a verdict.';
    case 'human_decision':
      return 'An owner decision is required; nothing automated will move this.';
    case 'self_resolving_wait':
      return waitingOn.waitUntil
        ? `Nothing to do — this resumes on its own at ${waitingOn.waitUntil}.`
        : 'Nothing to do — this resumes on its own.';
  }
}
