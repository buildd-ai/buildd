/**
 * Failure incident recovery — the assessment (docs/specs/failure-incident-recovery.md).
 *
 * Every open failure incident carries one recovery assessment
 * (`failure_incidents.recovery`): what is wrong, what Buildd is doing about it
 * and when it looks next. This module is the family-independent half:
 *
 *  - `planRecovery` (pure): fold a family policy's verdict on FRESH facts into
 *    the next assessment — generation, budget, deadline, backoff, the state
 *    mapping of §4, and the one repair to run, if any.
 *  - `assessIncident`: re-observe, plan, re-observe again and compare evidence
 *    revisions (§5 rule 1, I-3), record the repair's action key in the same
 *    CAS that writes the assessment (I-4), then run the repair through an
 *    existing writer. Never throws.
 *
 * A family (path overlap first: `failure-incident-recovery-path-overlap.ts`)
 * supplies `observe` (read facts from their owners) and `evaluate` (its policy
 * rules). Recovery never claims, starts or orders a task: its repairs are the
 * writers in spec §1.3, reached through `RecoveryEffects`.
 */
import { createHash } from 'node:crypto';
import type {
  FailureCauseOwnership,
  FailureIncidentRecovery,
  FailureIncidentRule,
  FailureRecoveryAttempt,
  FailureRecoveryBlocker,
  FailureRecoveryDecision,
  FailureRecoveryRef,
  FailureRecoveryState,
} from '@buildd/shared';
import { MAX_AFFECTED_REFS } from './failure-pattern-sentinel';
import { causeScope, nextCauseGroup, ruleCauseKey } from './failure-incident-cause-key';
import { buildAttemptEvent, dbRecoveryEvents, repairKindOf, verifyPriorAttempt, type RecoveryEventsPort } from './failure-incident-recovery-events';
import { automationGate, buildAutomationState, rulePolicy, type AutomationState } from './failure-incident-recovery-automation';
import { leadIncidentOf, SHARED_REPAIR_ACTIONS } from './failure-incident-repairs';
import {
  applyIncidentAction,
  DEFAULT_MAX_UPSERT_ATTEMPTS,
  type IncidentStorePort,
  type StoredIncident,
} from './failure-incident-store';

// ── Defaults (§8) ───────────────────────────────────────────────────────────

/** Repairs per generation. A fourth identical repair is evidence repairing does not work. */
export const RECOVERY_BUDGET_LIMIT = 3;
/** Minutes between checks while nothing changes: 5, then 15, then 45, capped at 2 h. */
export const RECOVERY_BACKOFF_MINUTES = [5, 15, 45, 120] as const;
/** A repair is checked again this soon. */
export const RECOVERY_REPAIR_RECHECK_MINUTES = 2;
/** Episode age past which a wait or a repair loop becomes a decision. */
export const RECOVERY_EPISODE_DEADLINE_MINUTES = 360;
/** An assessment with no observation for this long is `inconclusive`. 2× the cron cadence. */
export const RECOVERY_STALE_MINUTES = 60;
/** The repair lease (`system_cache` `failure-incident-recovery:<id>`). */
export const RECOVERY_LEASE_MS = 120_000;
export const MAX_RECOVERY_SPENT_KEYS = 20;
export const MAX_RECOVERY_ATTEMPTS = 20;

const minutesAfter = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();
const minutesBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60_000;

// ── Keys and revisions (§8) ─────────────────────────────────────────────────

/** Stable JSON: object keys sorted, so the same facts always hash the same. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v instanceof Map) return stableStringify(Object.fromEntries([...v.entries()].map(([k, x]) => [String(k), x])));
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

/** Hash of the facts read. Same facts → same revision. */
export function evidenceRevision(facts: unknown): string {
  return createHash('sha256').update(stableStringify(facts)).digest('hex').slice(0, 16);
}

export const recoveryGenerationKey = (incidentId: string, generation: number) => `recovery:${incidentId}:g${generation}`;

export function recoveryActionKey(k: {
  incidentId: string; subject: FailureRecoveryRef; causeCode: string; action: string; generation: number; attempt: number;
}): string {
  return `recovery:${k.incidentId}:${k.subject.kind}:${k.subject.id}:${k.causeCode}:${k.action}:g${k.generation}:a${k.attempt}`;
}

// ── Policy outcome (what a family concluded on fresh facts) ─────────────────

export type RecoveryRepairAction =
  | 'release_blocker' | 'wake_subject' | 'file_fix_task' | 'release_hold' | 'retry_capture'
  // operator-recovery §9.2 (B2). Each starts in shadow (§9.5).
  | 'redeliver_dispatch' | 'retry_stale_worker' | 'rerun_visual_audit' | 'kernel_ci_retry';

export type RecoveryVerdict =
  /** The family's check passed on this observation. */
  | { kind: 'passed'; summary: string }
  /** Run one repair. `once`: at most one per generation (e.g. a wake). */
  | { kind: 'repair'; action: RecoveryRepairAction; subject: FailureRecoveryRef; label: string; params: Record<string, unknown>; once?: boolean }
  /** A live blocker that is moving: wait for it. */
  | { kind: 'wait'; label: string; nextCheckAt?: string | null }
  /**
   * Someone else's machinery owns the next step: the blocker's own escalation
   * card (`blocked_by_escalation`), or the incident's fix task. No deadline:
   * waiting is the recovery, and the person already has the one card.
   */
  | { kind: 'delegated'; nextActionKind: 'blocked_by_escalation' | 'fix_task_running'; label: string; ref: string }
  /** Waiting cannot help: one typed decision for a person. */
  | { kind: 'decide'; decision: FailureRecoveryDecision }
  /** Buildd lacks a capability to recover; no workspace person can supply it (§16). */
  | { kind: 'operator'; capability: string; reason: string; label: string }
  /** No rule matched, or the facts could not decide. Never resolved. */
  | { kind: 'inconclusive'; reason: string };

export interface RecoveryPolicyOutcome {
  cause: { reasonCode: string; rule: FailureIncidentRule; ownership: FailureCauseOwnership };
  subjects: FailureRecoveryRef[];
  blockers: FailureRecoveryBlocker[];
  overlappingPaths: string[];
  /** This episode's start (§5 rule 3). */
  episodeStartedAt: string;
  lastProgressAt: string | null;
  verdict: RecoveryVerdict;
  verification: { predicate: string; params: Record<string, unknown> };
  /** What a person is offered when the budget or the deadline runs out. */
  fallbackDecision: FailureRecoveryDecision;
  /**
   * An infrastructure cause (§16.3 rule 5, §18.4): exhaustion alone is not a
   * person's decision. When set, a spent budget or a passed deadline is
   * `needs_operator` with this gap instead of `fallbackDecision`.
   */
  fallbackOperator?: { capability: string; reason: string; label: string };
}

export type RecoverySource = FailureIncidentRecovery['observation']['source'];

export interface PlannedRepair {
  key: string;
  action: RecoveryRepairAction;
  subject: FailureRecoveryRef;
  params: Record<string, unknown>;
}

export interface RecoveryPlan {
  recovery: FailureIncidentRecovery;
  repair: PlannedRepair | null;
  /** The assessment means something different from the stored one (re-gate on it). */
  changed: boolean;
}

const refKey = (r: { kind: string; id: string }) => `${r.kind}:${r.id}`;

/** What, if it changes, starts a new generation: the cause, the subject set and the blocker set. */
function identityOf(r: { cause: { reasonCode: string }; subjects: FailureRecoveryRef[]; blockers: Array<{ kind: string; id: string }> }): string {
  return stableStringify({
    cause: r.cause.reasonCode,
    subjects: r.subjects.map(refKey).sort(),
    blockers: r.blockers.map(refKey).sort(),
  });
}

/** The next backoff step after the interval the prior assessment waited. */
export function nextBackoffMinutes(
  prior: Pick<FailureIncidentRecovery, 'observation' | 'nextCheckAt'> | null,
  steps: readonly number[] = RECOVERY_BACKOFF_MINUTES,
): number {
  if (!prior?.nextCheckAt) return steps[0];
  const waited = minutesBetween(prior.observation.observedAt, prior.nextCheckAt);
  return steps.find(m => m > waited + 0.5) ?? steps[steps.length - 1];
}

/**
 * The owner's policy for one family (operator-recovery §8.4), as the planner
 * takes it. Absent: FIR's defaults. A new limit only applies to a new budget,
 * so an owner's budget extension survives the generation.
 */
export interface RecoveryPlanPolicy {
  budgetLimit: number;
  backoffMinutes: readonly number[];
  episodeDeadlineMinutes: number;
}

export function planPolicyFrom(state: AutomationState, rule: string): RecoveryPlanPolicy {
  const p = rulePolicy(state.policy, rule);
  const last = p.backoffMinutes[p.backoffMinutes.length - 1] ?? RECOVERY_BACKOFF_MINUTES[0];
  return {
    budgetLimit: p.budgetLimit,
    // §8.4: the owner's steps, capped at 2 h like FIR's.
    backoffMinutes: last < 120 ? [...p.backoffMinutes, 120] : [...p.backoffMinutes],
    episodeDeadlineMinutes: p.episodeDeadlineHours * 60,
  };
}

/** What a customer reads while the platform owner has a platform cause (operator-recovery §8.5). */
export const PLATFORM_PROBLEM_LABEL = 'Buildd is working on a platform problem affecting this task.';

/** The stored assessment, when it is a v1 one. Anything else reads as not assessed. */
export function readRecovery(incident: Pick<StoredIncident, 'recovery'>): FailureIncidentRecovery | null {
  const r = incident.recovery;
  return r && r.v === 1 ? r : null;
}

/** An assessment with no observation in RECOVERY_STALE_MINUTES (§5 rule 2). */
export function recoveryIsStale(r: FailureIncidentRecovery | null, now: string): boolean {
  return !!r && r.state !== 'recovered' && minutesBetween(r.observation.observedAt, now) > RECOVERY_STALE_MINUTES;
}

/** Due for a look: never assessed, the promised check time passed, or stale. */
export function recoveryDue(incident: Pick<StoredIncident, 'recovery' | 'status'>, now: string): boolean {
  if (incident.status === 'resolved') return false;
  const r = readRecovery(incident);
  if (!r) return true;
  if (r.nextCheckAt && r.nextCheckAt <= now) return true;
  return recoveryIsStale(r, now);
}

/**
 * Pure. The next assessment for `incident` from a family's verdict on facts
 * read now. `complete: false` (a failed or partial read) is `inconclusive`,
 * never `recovered`. `allowRepair: false` plans the same state without
 * spending a repair (the facts moved between the two reads, §5 rule 1).
 */
export function planRecovery(input: {
  incident: StoredIncident;
  outcome: RecoveryPolicyOutcome;
  evidenceRevision: string;
  now: string;
  source: RecoverySource;
  complete: boolean;
  allowRepair?: boolean;
  policy?: RecoveryPlanPolicy;
}): RecoveryPlan {
  const { incident, outcome, now } = input;
  const prior = readRecovery(incident);
  const sameIdentity = !!prior && identityOf(prior) === identityOf(outcome);
  const generation = !prior ? 1 : sameIdentity ? prior.generation : prior.generation + 1;
  const deadlineAt = minutesAfter(outcome.episodeStartedAt, input.policy?.episodeDeadlineMinutes ?? RECOVERY_EPISODE_DEADLINE_MINUTES);
  const budget = prior && prior.generation === generation
    ? { ...prior.budget, deadlineAt }
    : { spent: 0, limit: input.policy?.budgetLimit ?? RECOVERY_BUDGET_LIMIT, deadlineAt, spentKeys: [] as string[] };
  const pastDeadline = now >= deadlineAt;

  const base = {
    v: 1 as const,
    generation,
    cause: outcome.cause,
    subjects: outcome.subjects.slice(0, MAX_AFFECTED_REFS),
    blockers: outcome.blockers.slice(0, MAX_AFFECTED_REFS),
    overlappingPaths: outcome.overlappingPaths.slice(0, 20),
    observation: { observedAt: now, source: input.source, evidenceRevision: input.evidenceRevision },
    firstSeenAt: outcome.episodeStartedAt,
    lastProgressAt: outcome.lastProgressAt,
    verification: outcome.verification,
    attempts: prior?.attempts ?? [],
    // Cause membership (operator-recovery §4.2), keyed on the refined cause code.
    causeGroup: nextCauseGroup(prior?.causeGroup, ruleCauseKey({ ...incident, recovery: { cause: outcome.cause } }), now),
  };
  // Backoff only grows while the state holds within one generation.
  const backoffFrom = prior && prior.generation === generation ? prior : null;
  const steps = input.policy?.backoffMinutes ?? RECOVERY_BACKOFF_MINUTES;
  const backoff = (state: FailureRecoveryState) =>
    minutesAfter(now, backoffFrom && backoffFrom.state === state ? nextBackoffMinutes(backoffFrom, steps) : steps[0]);

  // operator-recovery §8.5: a platform cause never routes a decision to a
  // customer. The choice goes to the platform owner's queue instead.
  const platformCause = causeScope(incident) === 'platform';
  const decide = (decision: FailureRecoveryDecision): FailureIncidentRecovery => platformCause
    ? operator({ capability: 'platform_decision', reason: decision.question, label: PLATFORM_PROBLEM_LABEL })
    : {
      ...base, lastSeenAt: now, owner: 'person', state: 'needs_decision',
      nextAction: { kind: 'decide', label: decision.question, key: recoveryGenerationKey(incident.id, generation) },
      nextCheckAt: null, decision, budget,
    };
  function operator(gap: { capability: string; reason: string; label: string }): FailureIncidentRecovery {
    return {
      ...base, lastSeenAt: now, owner: 'operator', state: 'needs_operator',
      nextAction: { kind: 'operator', label: gap.label, key: recoveryGenerationKey(incident.id, generation) },
      // Still looked at: an operator's fix is noticed and the incident resolves.
      nextCheckAt: backoff('needs_operator'), capabilityGap: { capability: gap.capability, reason: gap.reason }, budget,
    };
  }
  /** Budget or deadline spent: a person's decision, or the operator's for an infrastructure cause. */
  const exhausted = (): FailureIncidentRecovery => outcome.fallbackOperator ? operator(outcome.fallbackOperator) : decide(outcome.fallbackDecision);

  let recovery: FailureIncidentRecovery;
  let repair: PlannedRepair | null = null;
  const v: RecoveryVerdict = input.complete ? outcome.verdict : { kind: 'inconclusive', reason: 'The facts could not be read in full.' };

  switch (v.kind) {
    case 'passed':
      recovery = {
        ...base, lastSeenAt: prior?.lastSeenAt ?? now, owner: 'buildd', state: 'recovered',
        nextAction: null, nextCheckAt: null, budget,
        verification: { ...outcome.verification, params: { ...outcome.verification.params, summary: v.summary } },
      };
      break;
    case 'repair': {
      const prefix = recoveryActionKey({ incidentId: incident.id, subject: v.subject, causeCode: outcome.cause.reasonCode, action: v.action, generation, attempt: 0 }).slice(0, -1);
      // The same repair already ran this generation and its re-check is not
      // due: a concurrent trigger (merge hook, sweep, click) collapses onto it.
      const inFlight = !!backoffFrom && backoffFrom.state === 'recovering' && backoffFrom.nextAction?.key.startsWith(prefix) === true
        && !!backoffFrom.nextCheckAt && backoffFrom.nextCheckAt > now;
      // I-5: a repair at the limit, or past the episode deadline, is refused and becomes a decision.
      if (!inFlight && (budget.spent >= budget.limit || pastDeadline)) { recovery = exhausted(); break; }
      const used = budget.spentKeys.filter(k => k.startsWith(prefix)).length;
      const key = inFlight ? backoffFrom!.nextAction!.key : `${prefix}${v.once ? 1 : used + 1}`;
      const alreadySpent = budget.spentKeys.includes(key);
      const canRun = !alreadySpent && input.allowRepair !== false;
      recovery = {
        ...base, lastSeenAt: now, owner: 'buildd', state: 'recovering',
        nextAction: { kind: v.action, label: v.label, key },
        nextCheckAt: canRun ? minutesAfter(now, RECOVERY_REPAIR_RECHECK_MINUTES)
          : inFlight ? backoffFrom!.nextCheckAt : backoff('recovering'),
        budget: canRun
          ? { ...budget, spent: budget.spent + 1, spentKeys: [...budget.spentKeys, key].slice(-MAX_RECOVERY_SPENT_KEYS) }
          : budget,
      };
      if (canRun) {
        repair = { key, action: v.action, subject: v.subject, params: v.params };
        const attempt: FailureRecoveryAttempt = { key, action: v.action, subject: v.subject, at: now, generation };
        recovery.attempts = [...base.attempts, attempt].slice(-MAX_RECOVERY_ATTEMPTS);
      }
      break;
    }
    case 'wait':
      if (pastDeadline) { recovery = exhausted(); break; }
      recovery = {
        ...base, lastSeenAt: now, owner: 'buildd', state: 'waiting',
        nextAction: { kind: 'wait', label: v.label, key: recoveryGenerationKey(incident.id, generation) },
        nextCheckAt: v.nextCheckAt && v.nextCheckAt > now ? v.nextCheckAt : backoff('waiting'), budget,
      };
      break;
    case 'delegated': {
      const state: FailureRecoveryState = v.nextActionKind === 'fix_task_running' ? 'recovering' : 'waiting';
      recovery = {
        ...base, lastSeenAt: now, owner: 'buildd', state,
        nextAction: { kind: v.nextActionKind, label: v.label, key: v.ref },
        nextCheckAt: backoff(state), budget,
      };
      break;
    }
    case 'decide':
      recovery = decide(v.decision);
      break;
    case 'operator':
      recovery = operator(v);
      break;
    case 'inconclusive':
      recovery = {
        ...base, lastSeenAt: prior?.lastSeenAt ?? now, owner: 'buildd', state: 'inconclusive',
        nextAction: { kind: 'recheck', label: v.reason, key: recoveryGenerationKey(incident.id, generation) },
        nextCheckAt: backoff('inconclusive'), budget,
      };
      break;
  }

  // A person's dismissal survives re-assessment within the generation.
  if (prior?.decision?.chosen && recovery.decision && prior.generation === generation) {
    recovery.decision = { ...recovery.decision, chosen: prior.decision.chosen };
  }

  return { recovery, repair, changed: recoveryChanged(prior, recovery) };
}

/** The parts of an assessment a surface or the gate reads. Times alone are not a change. */
export function recoveryChanged(prior: FailureIncidentRecovery | null, next: FailureIncidentRecovery): boolean {
  if (!prior) return true;
  const sig = (r: FailureIncidentRecovery) => stableStringify({
    g: r.generation, s: r.state, o: r.owner, a: r.nextAction?.key ?? null, k: r.nextAction?.kind ?? null,
    e: r.observation.evidenceRevision, d: r.decision?.question ?? null,
  });
  return sig(prior) !== sig(next);
}

/**
 * The assessment a read failure leaves: the prior cause, subjects and episode,
 * marked inconclusive. Never recovered.
 */
export function inconclusiveOutcome(incident: StoredIncident, reason: string): RecoveryPolicyOutcome {
  const prior = readRecovery(incident);
  return {
    cause: prior?.cause ?? { reasonCode: incident.reasonCode, rule: incident.rule, ownership: 'workflow' },
    subjects: prior?.subjects ?? incident.affectedRefs.taskIds.map(id => ({ kind: 'task' as const, id })),
    blockers: prior?.blockers ?? [],
    overlappingPaths: prior?.overlappingPaths ?? [],
    episodeStartedAt: prior?.firstSeenAt ?? incident.firstSeenAt,
    lastProgressAt: prior?.lastProgressAt ?? null,
    verdict: { kind: 'inconclusive', reason },
    verification: prior?.verification ?? { predicate: 'unknown', params: {} },
    fallbackDecision: prior?.decision ?? {
      question: 'Buildd could not confirm this incident. Dismiss it, or have Buildd try again?',
      options: [
        { capability: 'retry_recovery', label: 'Try again', effect: 'Buildd re-reads the facts and repairs what it can.' },
        { capability: 'dismiss', label: 'Dismiss', effect: 'It leaves Needs You; Buildd keeps checking it.' },
      ],
      recommended: 'retry_recovery',
    },
  };
}

// ── Orchestration ───────────────────────────────────────────────────────────

/** One failure family's recovery: read its facts, and judge them. */
export interface RecoveryFamily<F = unknown> {
  rule: FailureIncidentRule;
  /** Narrower than the rule: this family owns only these incidents of it. Absent: every incident of the rule. */
  applies?(incident: StoredIncident): boolean;
  /** Read the facts from their owners. Throw or return `complete: false` on a failed/partial read. */
  observe(incident: StoredIncident): Promise<{ complete: boolean; facts: F }>;
  /** Pure: the policy over those facts. */
  evaluate(incident: StoredIncident, facts: F, now: string): RecoveryPolicyOutcome;
  /**
   * The family's adapters to its subjects (§16.4), after the assessment is
   * written: `incident` is the row as swapped, `prior` the one it replaced.
   * Only existing writers; idempotent; a throw is logged, never re-planned.
   */
  afterAssess?(incident: StoredIncident, prior: StoredIncident): Promise<void>;
}

/** The existing writers repairs go through (spec §1.3). Each is idempotent on its own. */
export interface RecoveryEffects {
  releaseBlocker(blockerTaskId: string, reason: 'merged' | 'abandoned', key: string): Promise<void>;
  wakeSubject(taskId: string, key: string): Promise<void>;
  fileFixTask(incident: StoredIncident, key: string): Promise<string | null>;
  /** Release credential holds (task-recovery-hold.ts, §18.4). Optional: families without holds never plan it. */
  releaseHold?(taskIds: string[], key: string): Promise<string[]>;
  /** Re-queue blocked audits for a fresh capture (§16.3 rule 4). Optional: only the capture family plans it. */
  retryCapture?(taskIds: string[], key: string): Promise<string[]>;
  // operator-recovery §9.2 writers (B2). Optional: a plan for one with no writer is a failed attempt.
  /** A new outbox row for an undelivered task (`wakeTask`, notBefore now). */
  redeliverDispatch?(taskId: string, key: string): Promise<void>;
  /** Ask the runner to recover its stalled worker (`attemptStaleRecovery`). */
  retryStaleWorker?(accountId: string, key: string): Promise<string[]>;
  /** One audit re-run per mission (`requestMissionSurfaceAudit`, or the blocked audit re-queued). Returns the audit task ids. */
  rerunVisualAudit?(missionIds: string[], blockedTaskIds: string[], key: string): Promise<string[]>;
  /** `requestCiRetry` through the delivery kernel. True when the kernel applied it. */
  kernelCiRetry?(params: { workspaceId: string; repoFullName: string; prNumber: number; installationId: number }, key: string): Promise<boolean>;
  /** Link a cause's one fix task to another member (`link_fix_task`, first writer wins). */
  linkFixTask?(incidentId: string, taskId: string): Promise<void>;
}

export interface RecoveryDeps {
  port: IncidentStorePort;
  families: ReadonlyArray<RecoveryFamily<any>>;
  effects: RecoveryEffects;
  /** The repair lease (insert-or-take-if-expired). Absent: the action key alone guards. */
  claimLease?(incidentId: string, ms: number): Promise<boolean>;
  /** Attempt rows (gate `incident_recovery`). Absent: nothing is recorded. */
  events?: RecoveryEventsPort;
  /**
   * Pause, policy and rollout (operator-recovery §8.3, §9.5), read before
   * every automatic repair. Absent: FIR's defaults and nothing paused. A read
   * that throws is paused (fail closed).
   */
  automation?(): Promise<AutomationState>;
  /** The other open incidents under the same cause key (§9.1). Absent: every incident repairs alone. */
  causePeers?(incident: StoredIncident, causeKey: string): Promise<StoredIncident[]>;
  /**
   * The repair's own verify predicate (§9.2, §9.4) on facts read now, given
   * FIR's generic result. Absent: the generic result stands.
   */
  verifyRepair?(incident: StoredIncident, attempt: FailureRecoveryAttempt, generic: ReturnType<typeof verifyPriorAttempt>): Promise<ReturnType<typeof verifyPriorAttempt>>;
  now?: () => string;
}

export type AssessOutcome = 'assessed' | 'repaired' | 'skipped' | 'contended';

export interface AssessResult {
  outcome: AssessOutcome;
  before: StoredIncident | null;
  incident: StoredIncident | null;
  changed: boolean;
  repair: PlannedRepair | null;
}

async function observeOnce<F>(family: RecoveryFamily<F>, incident: StoredIncident, now: string) {
  try {
    const { complete, facts } = await family.observe(incident);
    const outcome = family.evaluate(incident, facts, now);
    return { complete, outcome, revision: evidenceRevision({ complete, facts }) };
  } catch (err) {
    return {
      complete: false,
      outcome: inconclusiveOutcome(incident, `The facts could not be read: ${err instanceof Error ? err.message.slice(0, 120) : 'read failed'}.`),
      revision: 'unreadable',
    };
  }
}

/**
 * Assess one incident on fresh facts and run at most one repair (§5, §8).
 *
 * Re-observe → plan → if it plans a repair: claim the lease and re-observe
 * again; a different evidence revision drops the repair and the fresher
 * assessment is written instead (I-3) → CAS the assessment, with the repair's
 * action key spent in the same write (I-4) → run the repair. A CAS that loses
 * re-reads and re-plans. A resolved incident, or one no family owns, is
 * skipped. Never throws.
 */
export async function assessIncident(deps: RecoveryDeps, incidentId: string, source: RecoverySource): Promise<AssessResult> {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const none = (outcome: AssessOutcome, before: StoredIncident | null = null): AssessResult =>
    ({ outcome, before, incident: before, changed: false, repair: null });
  try {
    for (let round = 1; round <= DEFAULT_MAX_UPSERT_ATTEMPTS; round++) {
      const row = await deps.port.findById(incidentId);
      if (!row || row.status === 'resolved') return none('skipped', row);
      const family = deps.families.find(f => f.rule === row.rule && (!f.applies || f.applies(row)));
      if (!family) return none('skipped', row);

      const automation = deps.automation ? await deps.automation().catch(() => buildAutomationState(null, new Date(now))) : null;
      const policy = automation ? planPolicyFrom(automation, row.rule) : undefined;
      const first = await observeOnce(family, row, now);
      const planOn = (o: typeof first, allowRepair?: boolean) =>
        planRecovery({ incident: row, outcome: o.outcome, evidenceRevision: o.revision, now, source, complete: o.complete, policy, ...(allowRepair === false ? { allowRepair } : {}) });
      let plan = planOn(first);
      let hold: RepairHold | null = null;
      if (plan.repair) {
        hold = await holdRepair(deps, row, plan, automation, () => planOn(first, false));
        if (hold) plan = hold.plan;
      }

      if (plan.repair) {
        if (deps.claimLease && !(await deps.claimLease(row.id, RECOVERY_LEASE_MS).catch(() => false))) return none('contended', row);
        const second = await observeOnce(family, row, now);
        if (second.revision !== first.revision) plan = planOn(second, false);
      }

      const swapped = await deps.port.compareAndSwap(row.id, row.version, applyIncidentAction(row, { type: 'assess', recovery: plan.recovery }, now));
      if (!swapped) continue; // another writer moved it: re-read and re-plan

      if (family.afterAssess) {
        await family.afterAssess(swapped, row).catch(err => console.error(`[failure-incident-recovery] adapters failed for ${row.id}:`, err));
      }
      const prior = readRecovery(row);
      let verified = verifyPriorAttempt(prior, plan.recovery);
      if (deps.verifyRepair && prior) {
        // The newest attempt is judged on every look until a verdict lands (the
        // write is first-verdict-wins), not only on the look right after it: a
        // repair's own window can outlast that look (§9.4).
        const last = prior.attempts[prior.attempts.length - 1];
        const inFlight = !!last && plan.recovery.state === 'recovering' && plan.recovery.nextAction?.key === last.key;
        const recent = !!last && Date.parse(now) - Date.parse(last.at) <= RECOVERY_EPISODE_DEADLINE_MINUTES * 60_000;
        if (last && recent && !inFlight && plan.recovery.state !== 'inconclusive' && plan.recovery.state !== 'observing') {
          const generic = verified ?? {
            actionKey: last.key,
            passed: plan.recovery.state === 'recovered' || (!!plan.recovery.lastProgressAt && plan.recovery.lastProgressAt > last.at),
            predicate: plan.recovery.verification.predicate,
            evidenceRevision: plan.recovery.observation.evidenceRevision,
          };
          verified = await deps.verifyRepair(swapped, last, generic).catch(() => verified);
        }
      }
      if (verified && deps.events) await deps.events.verify(verified.actionKey, verified).catch(() => {});
      if (hold?.shadow && deps.events) {
        // Recorded once per would-be key: a later sweep holding the same key adds nothing (§9.5).
        await deps.events.attempt({ ...buildAttemptEvent({ incident: swapped, recovery: plan.recovery, repair: hold.shadow, source, ok: true }), outcome: 'deferred' }).catch(() => {});
      }
      if (hold?.linkFix && deps.effects.linkFixTask) await deps.effects.linkFixTask(swapped.id, hold.linkFix).catch(() => {});
      if (plan.repair) {
        const ran = await runRepair(deps.effects, swapped, plan.repair);
        if (ran.fixTaskId && hold?.peers?.length && deps.effects.linkFixTask) {
          // One fix task for the cause: every member is linked to it.
          for (const p of hold.peers) await deps.effects.linkFixTask(p.id, ran.fixTaskId).catch(() => {});
        }
        if (deps.events) {
          const event = buildAttemptEvent({ incident: swapped, recovery: plan.recovery, repair: plan.repair, source, ok: ran.ok });
          if (hold?.peers?.length) {
            event.detail.members = {
              incidentIds: [swapped.id, ...hold.peers.map(p => p.id)],
              subjects: [...(readRecovery(swapped)?.subjects ?? []), ...hold.peers.flatMap(p => readRecovery(p)?.subjects ?? [])].slice(0, MAX_AFFECTED_REFS),
            };
          }
          await deps.events.attempt(event).catch(() => {});
        }
      }
      return { outcome: plan.repair ? 'repaired' : 'assessed', before: row, incident: swapped, changed: plan.changed, repair: plan.repair };
    }
    return none('contended');
  } catch (err) {
    console.error(`[failure-incident-recovery] assess failed for ${incidentId}:`, err);
    return none('skipped');
  }
}

interface RepairHold {
  plan: RecoveryPlan;
  /** The repair a shadow policy would have run, to record (once) as an attempt with outcome `shadow`. */
  shadow?: PlannedRepair;
  /** A member following the lead: link the lead's fix task to it. */
  linkFix?: string;
  /** The lead of a shared cause: its peers, whose subjects the repair covers and which get its fix linked. */
  peers?: StoredIncident[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** A planned repair turned into a hold: `waiting`, nothing spent, the would-be key kept (so a hold is idempotent). */
function heldPlan(prior: FailureIncidentRecovery | null, unspent: RecoveryPlan, kind: 'paused' | 'shadow' | 'off' | 'shared_repair', label: string, key?: string): RecoveryPlan {
  const r = unspent.recovery;
  const recovery: FailureIncidentRecovery = {
    ...r, owner: 'buildd', state: 'waiting',
    nextAction: { kind, label, key: key ?? r.nextAction?.key ?? recoveryGenerationKey('-', r.generation) },
  };
  return { recovery, repair: null, changed: recoveryChanged(prior, recovery) };
}

/**
 * operator-recovery §8.3, §9.1, §9.5: before the loop runs a repair on its own.
 *  - Paused (or the switch unreadable), switched off, or still in shadow: hold
 *    it as `waiting` with `nextAction.kind` paused / off / shadow; detection
 *    and verification go on. Shadow records what would have run.
 *  - A repair on a fault the whole cause shares runs once, on the lead; the
 *    other members hold with `shared_repair` and spend no budget. The lead's
 *    repair covers every member's subjects.
 * Null: run it as planned.
 */
async function holdRepair(
  deps: RecoveryDeps, row: StoredIncident, plan: RecoveryPlan, automation: AutomationState | null, unspent: () => RecoveryPlan,
): Promise<RepairHold | null> {
  const repair = plan.repair!;
  const prior = readRecovery(row);
  const causeKey = plan.recovery.causeGroup?.key ?? null;
  if (automation) {
    const gate = automationGate(automation, { rule: row.rule, causeKey, action: repair.action, kind: repairKindOf(repair.action) });
    if (!gate.run) {
      const held = heldPlan(prior, unspent(), gate.why, gate.label);
      const already = prior?.nextAction?.kind === 'shadow' && prior.nextAction.key === held.recovery.nextAction?.key;
      return {
        plan: held,
        ...(gate.why === 'shadow' && !already ? { shadow: { ...repair, key: held.recovery.nextAction!.key } } : {}),
      };
    }
  }
  if (!deps.causePeers || !causeKey || !SHARED_REPAIR_ACTIONS.has(repair.action)) return null;
  const peers = await deps.causePeers(row, causeKey).catch(() => [] as StoredIncident[]);
  if (peers.length === 0) return null;
  // A peer already filed the cause's fix (it was assessed first): follow it, never file a second.
  const filed = repair.action === 'file_fix_task' ? peers.find(p => !!p.linkedFixTaskId) : undefined;
  const lead = filed ?? leadIncidentOf([row, ...peers])!;
  if (lead.id !== row.id) {
    const leadR = readRecovery(lead);
    const key = leadR?.nextAction?.key ?? recoveryGenerationKey(lead.id, leadR?.generation ?? 1);
    return {
      plan: heldPlan(prior, unspent(), 'shared_repair', `One repair runs for every incident with this cause, on incident ${lead.id.slice(0, 8)}.`, key),
      ...(lead.linkedFixTaskId && !row.linkedFixTaskId ? { linkFix: lead.linkedFixTaskId } : {}),
    };
  }
  // The lead: the one repair covers every member's subjects.
  const peerTasks = peers.flatMap(p => readRecovery(p)?.subjects.filter(s => s.kind === 'task').map(s => s.id) ?? p.affectedRefs.taskIds);
  const peerMissions = peers.flatMap(p => readRecovery(p)?.subjects.filter(s => s.kind === 'mission').map(s => s.id) ?? []);
  const params = { ...repair.params };
  if (repair.action === 'retry_capture' || repair.action === 'rerun_visual_audit') {
    params.taskIds = [...new Set([...strings(params.taskIds), ...peerTasks])];
  }
  if (repair.action === 'rerun_visual_audit') params.missionIds = [...new Set([...strings(params.missionIds), ...peerMissions])];
  return { plan: { ...plan, repair: { ...repair, params } }, peers };
}

async function runRepair(effects: RecoveryEffects, incident: StoredIncident, repair: PlannedRepair): Promise<{ ok: boolean; fixTaskId?: string | null }> {
  let fixTaskId: string | null | undefined;
  try {
    switch (repair.action) {
      case 'release_blocker': {
        const taskId = typeof repair.params.blockerTaskId === 'string' ? repair.params.blockerTaskId : null;
        if (taskId) await effects.releaseBlocker(taskId, repair.params.reason === 'abandoned' ? 'abandoned' : 'merged', repair.key);
        break;
      }
      case 'wake_subject':
        await effects.wakeSubject(repair.subject.id, repair.key);
        break;
      case 'file_fix_task':
        fixTaskId = await effects.fileFixTask(incident, repair.key);
        break;
      case 'release_hold': {
        const ids = Array.isArray(repair.params.taskIds) ? repair.params.taskIds.filter((x): x is string => typeof x === 'string') : [repair.subject.id];
        if (!effects.releaseHold) throw new Error('release_hold has no writer');
        await effects.releaseHold(ids, repair.key);
        break;
      }
      case 'retry_capture': {
        const ids = Array.isArray(repair.params.taskIds) ? repair.params.taskIds.filter((x): x is string => typeof x === 'string') : [repair.subject.id];
        if (!effects.retryCapture) throw new Error('retry_capture has no writer');
        await effects.retryCapture(ids, repair.key);
        break;
      }
      case 'redeliver_dispatch':
        if (!effects.redeliverDispatch) throw new Error('redeliver_dispatch has no writer');
        await effects.redeliverDispatch(repair.subject.id, repair.key);
        break;
      case 'retry_stale_worker': {
        const accountId = typeof repair.params.accountId === 'string' ? repair.params.accountId : null;
        if (!effects.retryStaleWorker || !accountId) throw new Error('retry_stale_worker has no writer or account');
        await effects.retryStaleWorker(accountId, repair.key);
        break;
      }
      case 'rerun_visual_audit': {
        if (!effects.rerunVisualAudit) throw new Error('rerun_visual_audit has no writer');
        const missionIds = strings(repair.params.missionIds);
        await effects.rerunVisualAudit(missionIds.length ? missionIds : repair.subject.kind === 'mission' ? [repair.subject.id] : [], strings(repair.params.taskIds), repair.key);
        break;
      }
      case 'kernel_ci_retry': {
        const p = repair.params as { workspaceId?: unknown; repoFullName?: unknown; prNumber?: unknown; installationId?: unknown };
        if (!effects.kernelCiRetry || typeof p.workspaceId !== 'string' || typeof p.repoFullName !== 'string' || typeof p.prNumber !== 'number' || typeof p.installationId !== 'number') {
          throw new Error('kernel_ci_retry has no writer or delivery');
        }
        // The kernel decides; a refusal is a failed attempt, never a success (§9.4).
        if (!(await effects.kernelCiRetry({ workspaceId: p.workspaceId, repoFullName: p.repoFullName, prNumber: p.prNumber, installationId: p.installationId }, repair.key))) {
          throw new Error('the kernel did not apply the CI retry');
        }
        break;
      }
    }
    return { ok: true, fixTaskId };
  } catch (err) {
    // The key is spent and the attempt recorded: a repair that threw is a
    // failed attempt, re-checked at nextCheckAt, never silently retried.
    console.error(`[failure-incident-recovery] repair ${repair.key} failed:`, err);
    return { ok: false };
  }
}

/** Run one planned repair through its writer (the owner path's executor shares the loop's). */
export const runPlannedRepair = runRepair;

/**
 * Assess every listed incident that is due (`recoveryDue`), or all of them
 * when `force`. Returns the results that ran. Never throws.
 */
export async function assessDueIncidents(
  deps: RecoveryDeps,
  incidents: ReadonlyArray<StoredIncident>,
  source: RecoverySource,
  opts: { force?: boolean } = {},
): Promise<AssessResult[]> {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const out: AssessResult[] = [];
  for (const i of incidents) {
    if (!opts.force && !recoveryDue(i, now)) continue;
    out.push(await assessIncident(deps, i.id, source));
  }
  return out;
}

// ── DB-backed effects and lease ─────────────────────────────────────────────

/** The repair lease: `system_cache` row, insert-or-take-if-expired, like the fix-task claim. */
export async function claimRecoveryLease(incidentId: string, ms: number): Promise<boolean> {
  const [{ db }, { systemCache }, { sql }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'),
  ]);
  const key = `failure-incident-recovery:${incidentId}`;
  const expiresAt = new Date(Date.now() + ms);
  const rows = await db
    .insert(systemCache)
    .values({ key, value: { incidentId }, expiresAt, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: systemCache.key,
      set: { value: { incidentId }, expiresAt, updatedAt: new Date() },
      setWhere: sql`${systemCache.expiresAt} IS NULL OR ${systemCache.expiresAt} < now()`,
    })
    .returning({ key: systemCache.key });
  return rows.length > 0;
}

/** Repairs through the writers that own them: releaseAndNotify, wakeTask, the fix-task path. */
export function productionRecoveryEffects(): RecoveryEffects {
  return {
    async releaseBlocker(blockerTaskId, reason) {
      const { releaseAndNotify } = await import('./path-claim-release');
      await releaseAndNotify(blockerTaskId, reason);
    },
    async wakeSubject(taskId, key) {
      const { wakeTask } = await import('./dispatch-authority');
      await wakeTask(taskId, 'path_claim.released', { metadata: { recoveryKey: key } });
    },
    async releaseHold(taskIds, key) {
      const { releaseCredentialHolds } = await import('./task-recovery-hold');
      return releaseCredentialHolds({ taskIds, by: key });
    },
    async retryCapture(taskIds) {
      const { requeueFailedTasks } = await import('./credential-recovery');
      return requeueFailedTasks(taskIds, 'task.requeued');
    },
    async redeliverDispatch(taskId, key) {
      const { wakeTask } = await import('./dispatch-authority');
      await wakeTask(taskId, 'task.requeued', { notBefore: new Date(), metadata: { recoveryKey: key } });
    },
    async retryStaleWorker(accountId) {
      const { attemptStaleRecovery } = await import('./stale-workers');
      return attemptStaleRecovery(accountId);
    },
    async rerunVisualAudit(missionIds, blockedTaskIds) {
      // A blocked audit still answers for its mission (isLiveAudit), so it is
      // re-queued on its own captureRef; a mission with none gets a new one.
      const [{ requeueFailedTasks }, { requestMissionSurfaceAudit }] = await Promise.all([import('./credential-recovery'), import('./mission-surface-audit')]);
      const requeued = blockedTaskIds.length ? await requeueFailedTasks(blockedTaskIds, 'task.requeued') : [];
      const out = [...requeued];
      for (const id of missionIds) {
        const r = await requestMissionSurfaceAudit(id);
        if (r.ok && !out.includes(r.taskId)) out.push(r.taskId);
      }
      return out;
    },
    async kernelCiRetry(p, key) {
      const { requestCiRetry } = await import('./workflow/kernel-client');
      const r = await requestCiRetry({ ...p, actor: 'buildd:recovery', maxAttempts: 3, reason: `operator recovery ${key}` });
      return r.handled === true && !!r.result && r.result.result === 'applied';
    },
    async linkFixTask(incidentId, taskId) {
      const { createDbIncidentPort, updateIncidentState } = await import('./failure-incident-store');
      await updateIncidentState(await createDbIncidentPort(), incidentId, { type: 'link_fix_task', taskId });
    },
    async fileFixTask(incident) {
      const { createDbFixTaskPort, buildFixTaskDraft } = await import('./failure-incident-actions');
      const { createDbIncidentPort, updateIncidentState } = await import('./failure-incident-store');
      const port = createDbFixTaskPort();
      const existing = incident.linkedFixTaskId ?? (incident.workspaceId ? await port.findOpenByIncident(incident.id, incident.workspaceId) : null);
      if (existing) return existing;
      if (!incident.workspaceId || !(await port.claim(incident.id))) return null;
      // The one fix task, through the action layer's own path and claim key.
      const taskId = await port.create(buildFixTaskDraft(incident, {
        classification: 'systemic_bug', floorSeverity: incident.severity, severity: incident.severity, confidence: null,
        reasonCode: readRecovery(incident)?.cause.reasonCode ?? incident.reasonCode, source: 'rule',
      }));
      await updateIncidentState(await createDbIncidentPort(), incident.id, { type: 'link_fix_task', taskId });
      return taskId;
    },
  };
}

/** The production deps. Families are passed in so this module stays family-free. */
export function productionRecoveryDeps(port: IncidentStorePort, families: ReadonlyArray<RecoveryFamily<any>>): RecoveryDeps {
  return { port, families, effects: productionRecoveryEffects(), claimLease: claimRecoveryLease, events: dbRecoveryEvents(), ...productionOperatorRecoveryDeps() };
}

/** Pause/policy, cause peers and per-repair verification (operator-recovery, B2) for any production deps. */
export function productionOperatorRecoveryDeps(): Pick<RecoveryDeps, 'automation' | 'causePeers' | 'verifyRepair'> {
  return {
    async automation() {
      const { readAutomationState } = await import('./failure-incident-recovery-automation');
      return readAutomationState();
    },
    async causePeers(incident, causeKey) {
      const { dbCausePeers } = await import('./failure-incident-repairs');
      return dbCausePeers(incident, causeKey);
    },
    async verifyRepair(incident, attempt, generic) {
      if (generic?.passed) return generic;
      const { loadRepairFacts, verifyRepair } = await import('./failure-incident-repairs');
      const facts = await loadRepairFacts(incident);
      const passed = verifyRepair(repairKindOf(attempt.action as RecoveryRepairAction), facts, attempt.at, false);
      // Still inside the repair's own window: no verdict yet, whatever the generic check says (§9.4).
      if (passed === null) return null;
      const r = readRecovery(incident);
      return {
        actionKey: attempt.key, passed,
        predicate: generic?.predicate ?? r?.verification.predicate ?? 'unknown',
        evidenceRevision: generic?.evidenceRevision ?? r?.observation.evidenceRevision ?? 'unknown',
      };
    },
  };
}
