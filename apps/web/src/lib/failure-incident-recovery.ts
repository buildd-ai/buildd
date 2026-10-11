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
import { nextCauseGroup, ruleCauseKey } from './failure-incident-cause-key';
import { buildAttemptEvent, dbRecoveryEvents, verifyPriorAttempt, type RecoveryEventsPort } from './failure-incident-recovery-events';
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

export type RecoveryRepairAction = 'release_blocker' | 'wake_subject' | 'file_fix_task' | 'release_hold';

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
export function nextBackoffMinutes(prior: Pick<FailureIncidentRecovery, 'observation' | 'nextCheckAt'> | null): number {
  if (!prior?.nextCheckAt) return RECOVERY_BACKOFF_MINUTES[0];
  const waited = minutesBetween(prior.observation.observedAt, prior.nextCheckAt);
  return RECOVERY_BACKOFF_MINUTES.find(m => m > waited + 0.5) ?? RECOVERY_BACKOFF_MINUTES[RECOVERY_BACKOFF_MINUTES.length - 1];
}

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
}): RecoveryPlan {
  const { incident, outcome, now } = input;
  const prior = readRecovery(incident);
  const sameIdentity = !!prior && identityOf(prior) === identityOf(outcome);
  const generation = !prior ? 1 : sameIdentity ? prior.generation : prior.generation + 1;
  const deadlineAt = minutesAfter(outcome.episodeStartedAt, RECOVERY_EPISODE_DEADLINE_MINUTES);
  const budget = prior && prior.generation === generation
    ? { ...prior.budget, deadlineAt }
    : { spent: 0, limit: RECOVERY_BUDGET_LIMIT, deadlineAt, spentKeys: [] as string[] };
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
  const backoff = (state: FailureRecoveryState) =>
    minutesAfter(now, backoffFrom && backoffFrom.state === state ? nextBackoffMinutes(backoffFrom) : RECOVERY_BACKOFF_MINUTES[0]);

  const decide = (decision: FailureRecoveryDecision): FailureIncidentRecovery => ({
    ...base, lastSeenAt: now, owner: 'person', state: 'needs_decision',
    nextAction: { kind: 'decide', label: decision.question, key: recoveryGenerationKey(incident.id, generation) },
    nextCheckAt: null, decision, budget,
  });
  const operator = (gap: { capability: string; reason: string; label: string }): FailureIncidentRecovery => ({
    ...base, lastSeenAt: now, owner: 'operator', state: 'needs_operator',
    nextAction: { kind: 'operator', label: gap.label, key: recoveryGenerationKey(incident.id, generation) },
    // Still looked at: an operator's fix is noticed and the incident resolves.
    nextCheckAt: backoff('needs_operator'), capabilityGap: { capability: gap.capability, reason: gap.reason }, budget,
  });
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
  /** Read the facts from their owners. Throw or return `complete: false` on a failed/partial read. */
  observe(incident: StoredIncident): Promise<{ complete: boolean; facts: F }>;
  /** Pure: the policy over those facts. */
  evaluate(incident: StoredIncident, facts: F, now: string): RecoveryPolicyOutcome;
}

/** The existing writers repairs go through (spec §1.3). Each is idempotent on its own. */
export interface RecoveryEffects {
  releaseBlocker(blockerTaskId: string, reason: 'merged' | 'abandoned', key: string): Promise<void>;
  wakeSubject(taskId: string, key: string): Promise<void>;
  fileFixTask(incident: StoredIncident, key: string): Promise<string | null>;
  /** Release credential holds (task-recovery-hold.ts, §18.4). Optional: families without holds never plan it. */
  releaseHold?(taskIds: string[], key: string): Promise<string[]>;
}

export interface RecoveryDeps {
  port: IncidentStorePort;
  families: ReadonlyArray<RecoveryFamily<any>>;
  effects: RecoveryEffects;
  /** The repair lease (insert-or-take-if-expired). Absent: the action key alone guards. */
  claimLease?(incidentId: string, ms: number): Promise<boolean>;
  /** Attempt rows (gate `incident_recovery`). Absent: nothing is recorded. */
  events?: RecoveryEventsPort;
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
      const family = deps.families.find(f => f.rule === row.rule);
      if (!family) return none('skipped', row);

      const first = await observeOnce(family, row, now);
      let plan = planRecovery({ incident: row, outcome: first.outcome, evidenceRevision: first.revision, now, source, complete: first.complete });

      if (plan.repair) {
        if (deps.claimLease && !(await deps.claimLease(row.id, RECOVERY_LEASE_MS).catch(() => false))) return none('contended', row);
        const second = await observeOnce(family, row, now);
        if (second.revision !== first.revision) {
          plan = planRecovery({ incident: row, outcome: second.outcome, evidenceRevision: second.revision, now, source, complete: second.complete, allowRepair: false });
        }
      }

      const swapped = await deps.port.compareAndSwap(row.id, row.version, applyIncidentAction(row, { type: 'assess', recovery: plan.recovery }, now));
      if (!swapped) continue; // another writer moved it: re-read and re-plan

      const verified = verifyPriorAttempt(readRecovery(row), plan.recovery);
      if (verified && deps.events) await deps.events.verify(verified.actionKey, verified).catch(() => {});
      if (plan.repair) {
        const ok = await runRepair(deps.effects, swapped, plan.repair);
        if (deps.events) {
          await deps.events.attempt(buildAttemptEvent({ incident: swapped, recovery: plan.recovery, repair: plan.repair, source, ok })).catch(() => {});
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

async function runRepair(effects: RecoveryEffects, incident: StoredIncident, repair: PlannedRepair): Promise<boolean> {
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
        await effects.fileFixTask(incident, repair.key);
        break;
      case 'release_hold': {
        const ids = Array.isArray(repair.params.taskIds) ? repair.params.taskIds.filter((x): x is string => typeof x === 'string') : [repair.subject.id];
        if (!effects.releaseHold) throw new Error('release_hold has no writer');
        await effects.releaseHold(ids, repair.key);
        break;
      }
    }
    return true;
  } catch (err) {
    // The key is spent and the attempt recorded: a repair that threw is a
    // failed attempt, re-checked at nextCheckAt, never silently retried.
    console.error(`[failure-incident-recovery] repair ${repair.key} failed:`, err);
    return false;
  }
}

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
  return { port, families, effects: productionRecoveryEffects(), claimLease: claimRecoveryLease, events: dbRecoveryEvents() };
}
