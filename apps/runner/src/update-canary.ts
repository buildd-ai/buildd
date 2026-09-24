/**
 * Post-update canary: a runner that just moved to a new commit proves it can
 * still finish each role's work before it is trusted, and rolls itself back if
 * it cannot.
 *
 * Why: the runner self-updates on every release, and a broken release used to
 * keep claiming and failing real work for hours — the health probe only proves
 * the module graph loads and the HTTP server binds, not that a reviewer (or any
 * other role) can still complete a task.
 *
 * How:
 *  - **Probation is detected at boot**, not inside one update path. The state
 *    file remembers the commit of the last boot; a boot on a different commit
 *    means *something* moved the tree (idle auto-update, a manual
 *    `/api/update`, an external reset + drift restart), and the previous commit
 *    becomes the rollback target. One detection point covers every path.
 *  - While on probation the runner watches its OWN terminal outcomes — no
 *    synthetic tasks. Per role, a success clears that role for the rest of the
 *    probation. A role trips after `tripCount` consecutive failures with an
 *    identical error signature and zero successes: the fingerprint of a
 *    deterministic regression, not of flaky tasks.
 *  - Infra-class failures (auth, provider usage/budget walls, network, the
 *    server stopping a worker, never-started, restart reconciliation) neither
 *    advance nor reset a streak — they say nothing about the new code.
 *  - Probation ends only on the time bound. It deliberately does NOT end early
 *    once "every role that ran has succeeded": a role that has not run yet (the
 *    reviewer in the incident this exists for) would escape the check.
 *  - On trip: stop claiming, file a friction task, wait for in-flight work to
 *    drain, persist the bad SHA as skipped, `rollbackTo` the recorded commit
 *    (the updater's own reset + clean reinstall), restart. The skip latch is
 *    keyed on the SHA and persisted, so the updater cannot re-apply it after
 *    the restart; any other advertised SHA — the next release — is allowed.
 *  - At most one automatic rollback per bad SHA: if it gets re-applied anyway
 *    (an operator's manual update), a repeat trip reports and halts but does
 *    not reset again, so the canary can never become a rollback loop.
 *
 * Everything is behind `BUILDD_UPDATE_CANARY` (default ON; `0/false/off/no`
 * is the kill switch, which also disarms the skip latch).
 */

import * as fs from 'fs';
import { join } from 'path';
import { resolveBuilddHome } from './buildd-home';
import { isAuthError, classifyClaimError } from './claim-breaker';
import { isBudgetExhaustionError } from '@buildd/core/budget-error-classifier';
import { isSessionBudgetCapError } from './claim-budget-signals';
import type { UpdateResult } from './updater';
import type { RunnerUpdateCanaryReport } from '@buildd/shared';

// ── Config ──────────────────────────────────────────────────────────────────

export interface CanaryConfig {
  enabled: boolean;
  /** Consecutive identical same-role failures (zero successes) that trip. */
  tripCount: number;
  /** How long a probation lasts. */
  windowMs: number;
}

export const DEFAULT_TRIP_COUNT = 3;
export const DEFAULT_WINDOW_MIN = 6 * 60;

export function readCanaryConfig(env: Record<string, string | undefined> = process.env): CanaryConfig {
  const raw = (env.BUILDD_UPDATE_CANARY ?? '').trim().toLowerCase();
  const enabled = !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
  const n = Number.parseInt(env.BUILDD_UPDATE_CANARY_TRIP_COUNT ?? '', 10);
  // Never 1: a single failure is exactly what a flaky task looks like.
  const tripCount = Number.isFinite(n) ? Math.max(2, n) : DEFAULT_TRIP_COUNT;
  const m = Number.parseInt(env.BUILDD_UPDATE_CANARY_WINDOW_MIN ?? '', 10);
  const windowMs = (Number.isFinite(m) && m > 0 ? m : DEFAULT_WINDOW_MIN) * 60_000;
  return { enabled, tripCount, windowMs };
}

// ── State ───────────────────────────────────────────────────────────────────

export interface RoleTally {
  successes: number;
  failureStreak: number;
  streakSignature: string | null;
  lastExcerpt: string | null;
  lastWorkspaceId: string | null;
}

export interface Probation {
  /** Rollback target: the commit this runner booted on before the update. */
  fromCommit: string;
  toCommit: string;
  startedAt: number;
  tripped: boolean;
  roles: Record<string, RoleTally>;
}

export interface CanaryTripRecord {
  at: number;
  badCommit: string;
  rollbackTo: string;
  role: string;
  signature: string;
  excerpt: string;
  failures: number;
  workspaceId: string | null;
  rollbackStatus: 'pending' | 'started' | 'succeeded' | 'failed' | 'not_attempted';
  rollbackError?: string;
}

export interface CanaryState {
  version: 1;
  lastBootCommit: string | null;
  probation: Probation | null;
  /** Bad SHA the updater must not re-apply. Cleared when a different commit boots. */
  skippedCommit: string | null;
  /** Set just before a rollback reset; the next boot landing on it is the rollback completing. */
  pendingRollbackTo: string | null;
  lastTrip: CanaryTripRecord | null;
}

export function emptyCanaryState(): CanaryState {
  return { version: 1, lastBootCommit: null, probation: null, skippedCommit: null, pendingRollbackTo: null, lastTrip: null };
}

/** Pure boot transition. See the module doc for the rules. */
export function applyBoot(prev: CanaryState, currentCommit: string | null, now: number): CanaryState {
  if (!currentCommit) return prev;
  const s: CanaryState = { ...prev };

  if (s.pendingRollbackTo) {
    if (currentCommit === s.pendingRollbackTo) {
      // The rollback landed. This boot is a return to known-good code, not an
      // update, so it is not a new probation. The skip latch stays armed.
      if (s.lastTrip) s.lastTrip = { ...s.lastTrip, rollbackStatus: 'succeeded' };
      return { ...s, pendingRollbackTo: null, probation: null, lastBootCommit: currentCommit };
    }
    s.pendingRollbackTo = null;
  }

  if (s.probation && s.probation.toCommit === currentCommit) {
    // Restart mid-probation: keep the tallies, the rollback target and the clock.
    return { ...s, lastBootCommit: currentCommit };
  }

  if (s.lastBootCommit && s.lastBootCommit !== currentCommit) {
    // Any commit other than the skipped one re-enables updates for good.
    if (s.skippedCommit && s.skippedCommit !== currentCommit) s.skippedCommit = null;
    s.probation = { fromCommit: s.lastBootCommit, toCommit: currentCommit, startedAt: now, tripped: false, roles: {} };
  } else {
    s.probation = null;
  }
  s.lastBootCommit = currentCommit;
  return s;
}

// ── Outcome classification ──────────────────────────────────────────────────

export type OutcomeKind = 'success' | 'failure' | 'infra';

export interface CanaryOutcome {
  role: string;
  workspaceId: string | null;
  kind: OutcomeKind;
  signature: string;
  excerpt: string;
}

/**
 * Failures that describe the platform, not this runner's code. Mirrors the
 * server's infra exit causes (worker-exit-taxonomy.ts: never_started,
 * server_refused, needs_input, condition_unmet, crash reconciliation,
 * concurrency conflicts) plus network-level faults; auth and provider walls go
 * through the same classifiers the claim breaker uses.
 */
const INFRA_PATTERNS: RegExp[] = [
  /never started/i,
  /process restarted/i,
  /terminated by server/i,
  /worker state changed concurrently/i,
  /no longer exists on remote server/i,
  /cancelled on remote server/i,
  /\baborted\b|\bcancell?ed\b/i,
  /^deferred:/i,
  /^needs_input:/i,
  /connector_(auth_expired|permission_insufficient)/i,
  /does not support this model[\s\S]*or newer is required/i,
  /stale worker expired/i,
  /\b(econnreset|econnrefused|etimedout|enotfound|eai_again|epipe|ehostunreach|enetunreach)\b/i,
  /fetch failed|socket hang up|network error|getaddrinfo/i,
  /\b(overloaded|rate.?limit|429|502|503|504)\b/i,
];

export function isInfraClassFailure(error: string): boolean {
  const lower = error.toLowerCase();
  if (isAuthError(lower)) return true;
  if (isBudgetExhaustionError(error) || isSessionBudgetCapError(error)) return true;
  if (classifyClaimError(lower)) return true;
  return INFRA_PATTERNS.some(p => p.test(error));
}

/**
 * Error-text fingerprint. Ids, SHAs, numbers and quoted paths vary between
 * tasks hitting the same bug; stripping them is what lets three different
 * reviewer tasks failing on one regression share a signature.
 */
export function errorSignature(error: string): string {
  return error
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export function classifyWorkerOutcome(w: { status: string; error?: string | null }): Omit<CanaryOutcome, 'role' | 'workspaceId'> {
  if (w.status === 'done') return { kind: 'success', signature: '', excerpt: '' };
  const error = (w.error ?? '').trim();
  const excerpt = error.split('\n')[0].slice(0, 300);
  if (error && isInfraClassFailure(error)) return { kind: 'infra', signature: errorSignature(error), excerpt };
  return { kind: 'failure', signature: error ? errorSignature(error) : '<no error text>', excerpt };
}

/** Role key a task is tallied under. Tasks with no role share one bucket. */
export function canaryRoleOf(roleSlug: string | null | undefined): string {
  return roleSlug && roleSlug.trim() ? roleSlug.trim() : '(no-role)';
}

// ── Outcome transition ──────────────────────────────────────────────────────

export interface CanaryTrip {
  badCommit: string;
  rollbackTo: string;
  role: string;
  signature: string;
  excerpt: string;
  failures: number;
  workspaceId: string | null;
  /** False when this SHA already got its one automatic rollback. */
  rollback: boolean;
}

export interface OutcomeDecision {
  state: CanaryState;
  event: 'none' | 'passed' | 'trip';
  trip?: CanaryTrip;
}

export function expireProbation(state: CanaryState, cfg: CanaryConfig, now: number): OutcomeDecision {
  const p = state.probation;
  if (!p || p.tripped) return { state, event: 'none' };
  if (now - p.startedAt < cfg.windowMs) return { state, event: 'none' };
  return { state: { ...state, probation: null }, event: 'passed' };
}

export function recordOutcome(state: CanaryState, outcome: CanaryOutcome, cfg: CanaryConfig, now: number): OutcomeDecision {
  if (!cfg.enabled || !state.probation) return { state, event: 'none' };
  const expired = expireProbation(state, cfg, now);
  if (expired.event === 'passed') return expired;

  const p = state.probation;
  if (p.tripped || outcome.kind === 'infra') return { state, event: 'none' };

  const prev: RoleTally = p.roles[outcome.role] ?? {
    successes: 0, failureStreak: 0, streakSignature: null, lastExcerpt: null, lastWorkspaceId: null,
  };
  let tally: RoleTally;
  if (outcome.kind === 'success') {
    tally = { ...prev, successes: prev.successes + 1, failureStreak: 0, streakSignature: null };
  } else if (prev.successes > 0) {
    // This role has already proven the new code can do its work.
    tally = prev;
  } else {
    const same = prev.streakSignature === outcome.signature;
    tally = {
      ...prev,
      failureStreak: same ? prev.failureStreak + 1 : 1,
      streakSignature: outcome.signature,
      lastExcerpt: outcome.excerpt,
      lastWorkspaceId: outcome.workspaceId,
    };
  }

  const probation: Probation = { ...p, roles: { ...p.roles, [outcome.role]: tally } };
  let next: CanaryState = { ...state, probation };

  if (outcome.kind !== 'failure' || tally.successes > 0 || tally.failureStreak < cfg.tripCount) {
    return { state: next, event: 'none' };
  }

  // 'pending'/'failed' mean no reset of this SHA ever completed (the handler
  // never ran, or the reset errored), so another attempt is still allowed.
  const alreadyRolledBack = state.lastTrip?.badCommit === p.toCommit
    && ['started', 'succeeded', 'not_attempted'].includes(state.lastTrip.rollbackStatus);
  const trip: CanaryTrip = {
    badCommit: p.toCommit,
    rollbackTo: p.fromCommit,
    role: outcome.role,
    signature: tally.streakSignature!,
    excerpt: tally.lastExcerpt ?? '',
    failures: tally.failureStreak,
    workspaceId: tally.lastWorkspaceId,
    rollback: !alreadyRolledBack,
  };
  next = {
    ...next,
    probation: { ...probation, tripped: true },
    lastTrip: {
      at: now,
      badCommit: trip.badCommit,
      rollbackTo: trip.rollbackTo,
      role: trip.role,
      signature: trip.signature,
      excerpt: trip.excerpt,
      failures: trip.failures,
      workspaceId: trip.workspaceId,
      rollbackStatus: trip.rollback ? 'pending' : 'not_attempted',
    },
  };
  return { state: next, event: 'trip', trip };
}

// ── Stateful wrapper ────────────────────────────────────────────────────────

export interface UpdateCanaryOptions {
  file?: string;
  config?: CanaryConfig;
  now?: () => number;
  /** Tests: start from this state instead of reading the file. */
  initialState?: CanaryState;
}

export function defaultCanaryFile(): string {
  return join(resolveBuilddHome(), 'update-canary.json');
}

export class UpdateCanary {
  readonly config: CanaryConfig;
  private readonly file: string;
  private readonly now: () => number;
  private state: CanaryState;
  private halted = false;
  private tripHandler: ((trip: CanaryTrip) => void) | null = null;

  constructor(opts: UpdateCanaryOptions = {}) {
    this.config = opts.config ?? readCanaryConfig();
    this.file = opts.file ?? defaultCanaryFile();
    this.now = opts.now ?? Date.now;
    this.state = opts.initialState ?? this.load();
  }

  private load(): CanaryState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      if (parsed && parsed.version === 1) return { ...emptyCanaryState(), ...parsed };
    } catch { /* missing or corrupt — fail open to an empty state */ }
    return emptyCanaryState();
  }

  private save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[update-canary] could not persist state to ${this.file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  boot(currentCommit: string | null): void {
    const before = this.state;
    this.state = applyBoot(this.state, currentCommit, this.now());
    this.save();
    if (!this.config.enabled) return;
    const p = this.state.probation;
    if (p && before.probation?.toCommit !== p.toCommit) {
      console.log(
        `[update-canary] updated ${p.fromCommit.slice(0, 7)} → ${p.toCommit.slice(0, 7)} — on probation for ` +
        `${Math.round(this.config.windowMs / 60_000)}min (trips on ${this.config.tripCount} identical failures of one role; ` +
        'BUILDD_UPDATE_CANARY=0 disables)',
      );
    }
    if (before.pendingRollbackTo && this.state.lastTrip?.rollbackStatus === 'succeeded' && !this.state.pendingRollbackTo) {
      console.error(
        `[update-canary] rolled back to ${this.state.lastBootCommit?.slice(0, 7)} — ${this.state.skippedCommit?.slice(0, 7) ?? 'the bad commit'} ` +
        'will not be re-applied; updates resume on the next newer release',
      );
    }
  }

  setTripHandler(fn: (trip: CanaryTrip) => void): void { this.tripHandler = fn; }

  onProbation(): boolean { return this.config.enabled && !!this.state.probation; }

  claimsHalted(): boolean { return this.config.enabled && this.halted; }

  haltClaims(): void { this.halted = true; }

  isSkipped(sha: string | null | undefined): boolean {
    return this.config.enabled && !!sha && sha === this.state.skippedCommit;
  }

  skippedCommit(): string | null { return this.config.enabled ? this.state.skippedCommit : null; }

  /** Periodic: end a probation whose time bound has passed. */
  tick(): void {
    const r = expireProbation(this.state, this.config, this.now());
    if (r.event === 'passed') {
      console.log(`[update-canary] probation passed for ${this.state.probation?.toCommit.slice(0, 7)}`);
      this.state = r.state;
      this.save();
    }
  }

  recordOutcome(outcome: CanaryOutcome): OutcomeDecision {
    const r = recordOutcome(this.state, outcome, this.config, this.now());
    if (r.state !== this.state) {
      this.state = r.state;
      this.save();
    }
    if (r.event === 'passed') {
      console.log('[update-canary] probation passed');
    }
    if (r.event === 'trip' && r.trip) {
      this.halted = true;
      console.error(
        `[update-canary] TRIPPED: role '${r.trip.role}' failed ${r.trip.failures}x in a row with the same error on ` +
        `${r.trip.badCommit.slice(0, 7)} and has not succeeded once — "${r.trip.excerpt}". Claims halted.`,
      );
      try { this.tripHandler?.(r.trip); } catch (err) {
        console.error('[update-canary] trip handler threw:', err);
      }
    }
    return r;
  }

  /** Persist the skip latch BEFORE the reset, so a crash mid-rollback cannot re-apply the bad SHA. */
  markRollbackStarted(trip: CanaryTrip): void {
    this.state = {
      ...this.state,
      skippedCommit: trip.badCommit,
      pendingRollbackTo: trip.rollbackTo,
      lastTrip: this.state.lastTrip ? { ...this.state.lastTrip, rollbackStatus: 'started' } : this.state.lastTrip,
    };
    this.save();
  }

  markRollbackFailed(error: string): void {
    this.state = {
      ...this.state,
      pendingRollbackTo: null,
      lastTrip: this.state.lastTrip ? { ...this.state.lastTrip, rollbackStatus: 'failed', rollbackError: error.slice(0, 300) } : null,
    };
    this.save();
  }

  report(): RunnerUpdateCanaryReport {
    const s = this.state;
    const short = (x: string | null | undefined) => (x ? x.slice(0, 12) : null);
    return {
      enabled: this.config.enabled,
      onProbation: this.onProbation(),
      probationFrom: short(s.probation?.fromCommit),
      probationTo: short(s.probation?.toCommit),
      probationStartedAt: s.probation ? new Date(s.probation.startedAt).toISOString() : null,
      claimsHalted: this.claimsHalted(),
      skippedCommit: short(this.skippedCommit()),
      lastTrip: s.lastTrip
        ? {
            at: new Date(s.lastTrip.at).toISOString(),
            role: s.lastTrip.role,
            badCommit: short(s.lastTrip.badCommit)!,
            rolledBackTo: short(s.lastTrip.rollbackTo)!,
            failures: s.lastTrip.failures,
            signature: s.lastTrip.signature,
            rollbackStatus: s.lastTrip.rollbackStatus,
            ...(s.lastTrip.rollbackError ? { rollbackError: s.lastTrip.rollbackError } : {}),
          }
        : null,
    };
  }
}

// ── Trip orchestration ──────────────────────────────────────────────────────

export interface CanaryFriction {
  workspaceId: string;
  title: string;
  description: string;
  signature: string;
  excerpt: string;
}

export interface CanaryTripDeps {
  emit: (event: { type: string; [k: string]: unknown }) => void;
  reportFriction: (f: CanaryFriction) => Promise<void>;
  /** Resolves once no worker is active. Claims are already halted. */
  waitForIdle: () => Promise<void>;
  rollbackTo: (sha: string) => Promise<UpdateResult>;
  restart: (reason: string) => void;
  setUpdating: (on: boolean) => void;
}

export function frictionSignatureFor(trip: Pick<CanaryTrip, 'badCommit' | 'role'>): string {
  return `runner-update-regression:${trip.badCommit.slice(0, 7)}:${trip.role}`;
}

export function buildFriction(trip: CanaryTrip): CanaryFriction | null {
  if (!trip.workspaceId) return null;
  const short = (x: string) => x.slice(0, 7);
  return {
    workspaceId: trip.workspaceId,
    title: `[friction] Runner update ${short(trip.badCommit)} broke role '${trip.role}' — ${trip.rollback ? `rolled back to ${short(trip.rollbackTo)}` : 'claims halted'}`,
    description: [
      `A runner that updated ${short(trip.rollbackTo)} → ${short(trip.badCommit)} failed ${trip.failures} consecutive '${trip.role}' tasks`,
      'with an identical error signature and no success for that role — the shape of a deterministic regression in the runner release,',
      'not of flaky tasks. Infra-class failures (auth, usage/budget walls, network, server-stopped workers) were excluded.',
      '',
      `Error: ${trip.excerpt || '(no error text)'}`,
      `Signature: ${trip.signature}`,
      '',
      trip.rollback
        ? `The runner stopped claiming, rolled itself back to ${short(trip.rollbackTo)} and will not re-apply ${short(trip.badCommit)}; it resumes updating on the next newer release.`
        : `${short(trip.badCommit)} was already rolled back once and got re-applied, so no second automatic rollback — claims are halted until an operator restarts or fixes the runner.`,
      'Kill switch: BUILDD_UPDATE_CANARY=0.',
    ].join('\n'),
    signature: frictionSignatureFor(trip),
    excerpt: trip.excerpt.slice(0, 200),
  };
}

export async function runCanaryTrip(canary: UpdateCanary, trip: CanaryTrip, deps: CanaryTripDeps): Promise<void> {
  canary.haltClaims();
  deps.emit({ type: 'update_canary_tripped', ...trip, report: canary.report() });

  const friction = buildFriction(trip);
  if (friction) {
    try { await deps.reportFriction(friction); } catch (err) {
      console.error(`[update-canary] friction report failed (continuing): ${err instanceof Error ? err.message : err}`);
    }
  }

  if (!trip.rollback) return;

  await deps.waitForIdle();
  deps.setUpdating(true);
  canary.markRollbackStarted(trip);
  let result: UpdateResult;
  try {
    result = await deps.rollbackTo(trip.rollbackTo);
  } catch (err) {
    result = { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!result.success) {
    const error = result.error || 'rollback failed';
    canary.markRollbackFailed(error);
    deps.setUpdating(false);
    console.error(`[update-canary] rollback to ${trip.rollbackTo.slice(0, 7)} FAILED: ${error} — claims stay halted; operator attention needed`);
    deps.emit({ type: 'update_canary_rollback_failed', error, report: canary.report() });
    return;
  }

  deps.emit({ type: 'update_canary_rolled_back', rolledBackTo: trip.rollbackTo, report: canary.report() });
  deps.restart(`update canary: role '${trip.role}' regressed on ${trip.badCommit.slice(0, 7)} — rolled back to ${trip.rollbackTo.slice(0, 7)}`);
}

// ── Process singleton ───────────────────────────────────────────────────────
//
// WorkerManager is re-created on config changes, so the canary lives at module
// scope. Unset (tests, or a process that never booted it) means every hook is
// a no-op.

let instance: UpdateCanary | null = null;

export function initUpdateCanary(opts: UpdateCanaryOptions = {}): UpdateCanary {
  instance = new UpdateCanary(opts);
  return instance;
}

export function getUpdateCanary(): UpdateCanary | null { return instance; }
