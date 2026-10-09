/**
 * A Buildd-owned gate verdict starts the work it names (task c06dedf5).
 *
 * The escalation gate (lib/escalation-gate-check.ts) parks a stuck PR on a
 * named next step ("Buildd is renumbering a migration…"). Until now only
 * `policy_merge` was run here; the rest were left to "the kernel's own sweep",
 * and for some PRs (an escalated mission refresh PR whose migration collides)
 * no sweep ever came, so the label promised work nothing was doing.
 *
 * Now the look that files a rule verdict also dispatches its step, through the
 * dispatcher that already owns that fix (no second decision path):
 *
 *   ci_fix             → retryCiFailureForPr (the CI webhook's and red sweep's entry)
 *   conflict_fix       → dispatchConflictRetry
 *   renumber_migration → tryDispatchMigrationCollisionRetry while the other PR
 *                        is open; once it merged or closed, a refresh from the
 *                        base (dispatchConflictRetry) picks its migration up
 *   retry_landing      → the landing sweep's due queue, now
 *   policy_merge       → the rule merge (lib/merge-policy-rule-executor.ts)
 *
 * Once per state: the claim is a `decision_outcomes` row (source
 * `escalation_dispatch`) on the verdict's decision record, inserted with
 * ON CONFLICT DO NOTHING on (decision_record_id, source). One verdict record is
 * one state, so a refresh, a second instance or the sweep never files twice.
 * The row then holds what happened, which is what the label reads.
 *
 * `sweepUndispatchedEscalations` (the hourly `sweep.pr_hourly` subscriber) dispatches verdicts no
 * look dispatched: the ones filed before this shipped, and any look that died
 * between filing and dispatching.
 */
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { decisionOutcomes, decisionRecords, gateEvents } from '@buildd/core/db/schema';
import {
  DISPATCHABLE_ACTIONS,
  DISPATCH_SOURCE,
  ESCALATION_GATE_CAPABILITY,
  verdictFromCode,
  type DispatchResult,
  type EscalationAction,
} from '@buildd/core/escalation-gate';

// The pure half (labels, the claim's source, which actions dispatch) lives in
// core, which the gate's read path uses; this module holds the dispatchers.
export { DISPATCH_GRACE_MS, DISPATCH_SOURCE, DISPATCHABLE_ACTIONS, labelWithDispatch, type DispatchResult, type StoredDispatch } from '@buildd/core/escalation-gate';
import type { CiFailureInput, CiRetryOutcome } from '@/lib/ci-failure-retry';
import type { CiRedPeek, CiRedResolution, CiRedTarget } from '@/lib/ci-red-sweep';
import type { DispatchConflictRetryParams, DispatchConflictRetryResult } from '@/lib/conflict-retry';
import type { MigrationCollisionRetryParams, MigrationCollisionRetryResult } from '@/lib/migration-collision-retry';
import { collisionFromReason } from '@/lib/pr-landing-fix-dispatch';

/** The sweep leaves a verdict this young to the look that filed it. */
export const SWEEP_MIN_AGE_MS = 10 * 60_000;
/** How far back the sweep looks: past the gate's own stuck ceiling a verdict is the person's anyway. */
export const SWEEP_WINDOW_MS = 6 * 60 * 60_000;

export interface DispatchTarget {
  /** The decision record of the verdict: the claim is keyed on it. */
  recordId: string;
  teamId: string;
  workspaceId: string;
  prNumber: number;
  taskId: string | null;
  action: EscalationAction;
  /** The escalation's own words, a fallback for the collision when no gate event names it. */
  detail?: string | null;
}

export interface DispatchDeps {
  /** True when this call won the verdict's one dispatch. */
  claim(recordId: string, teamId: string): Promise<boolean>;
  settle(recordId: string, result: DispatchResult): Promise<void>;
  resolve(workspaceId: string, prNumber: number): Promise<CiRedResolution>;
  peek(target: CiRedTarget): Promise<CiRedPeek>;
  retryCi(input: CiFailureInput): Promise<CiRetryOutcome>;
  conflictRetry(params: DispatchConflictRetryParams): Promise<DispatchConflictRetryResult>;
  renumber(params: MigrationCollisionRetryParams): Promise<MigrationCollisionRetryResult>;
  /** The newest gate event that named this task's migration collision, verbatim. */
  collisionReason(taskId: string | null): Promise<string | null>;
  prState(target: CiRedTarget, prNumber: number): Promise<'open' | 'closed' | 'merged' | null>;
  markLandingDue(member: string): Promise<void>;
  /** False when the workspace merge policy keeps the merge for a person. */
  policyMerge(p: { workspaceId: string; prNumber: number; headSha: string }): Promise<boolean>;
}

const skipped = (cause: string): DispatchResult => ({ kind: 'skipped', cause });

function fromConflict(r: DispatchConflictRetryResult): DispatchResult {
  if (r.taskId) return { kind: 'dispatched', taskId: r.taskId };
  if (r.inFlightTaskId) return { kind: 'dispatched', taskId: r.inFlightTaskId };
  if (r.exhausted) return skipped('conflict_fixes_spent');
  if (r.disabled) return skipped('conflict_fixes_off');
  if (r.superseded) return skipped('already_upstream');
  return skipped('conflict_fix_not_filed');
}

async function run(t: DispatchTarget, deps: DispatchDeps): Promise<DispatchResult> {
  const resolved = await deps.resolve(t.workspaceId, t.prNumber);
  if (!resolved.ok) return skipped(resolved.skip);
  const target = resolved.target;
  const pr = await deps.peek(target);
  if (pr.state !== 'open') return skipped(`pr_${pr.state}`);
  const base = {
    workerId: target.owner.workerId, taskId: target.owner.taskId, prNumber: t.prNumber, headSha: pr.headSha,
    repoFullName: target.repoFullName, workspaceId: t.workspaceId,
  };

  switch (t.action) {
    case 'ci_fix': {
      const out = await deps.retryCi({
        repoFullName: target.repoFullName, prNumber: t.prNumber, headSha: pr.headSha, installationId: target.installationId, surface: 'landing',
      });
      if (out.kind === 'dispatched' || out.kind === 'diagnose_dispatched') return { kind: 'dispatched', taskId: out.taskId };
      if (out.kind === 'skipped') return out.inFlightTaskId ? { kind: 'dispatched', taskId: out.inFlightTaskId } : skipped(out.reason);
      return skipped('not_ours');
    }
    case 'conflict_fix':
      return fromConflict(await deps.conflictRetry(base));
    case 'renumber_migration': {
      const reason = (await deps.collisionReason(t.taskId)) ?? t.detail ?? null;
      const collision = reason ? collisionFromReason(reason) : null;
      if (!collision) return skipped('collision_unreadable');
      const other = collision.otherPrNumber == null ? 'open' : await deps.prState(target, collision.otherPrNumber);
      if (other === 'open') {
        const res = await deps.renumber({ ...base, collision, installationId: target.installationId });
        if (!res.handled) return skipped('renumber_not_filed');
        return res.taskId ? { kind: 'dispatched', taskId: res.taskId } : skipped('renumber_not_filed');
      }
      // The other side landed or closed: a refresh from the base carries its
      // migration in, and the new head gets reviewed on its own.
      return fromConflict(await deps.conflictRetry(base));
    }
    case 'retry_landing':
      await deps.markLandingDue(`${t.workspaceId}:${t.prNumber}`);
      return { kind: 'queued', where: 'landing' };
    case 'policy_merge':
      return (await deps.policyMerge({ workspaceId: t.workspaceId, prNumber: t.prNumber, headSha: pr.headSha }))
        ? { kind: 'queued', where: 'landing' }
        : skipped('merge_policy_keeps_merge');
    default:
      return skipped('no_dispatcher');
  }
}

/**
 * Start the step a Buildd-owned rule verdict names, once per verdict record.
 * Null when there is nothing to start (a wait, a hold) or another caller
 * already started it. Never throws.
 */
export async function dispatchVerdictAction(t: DispatchTarget, deps: DispatchDeps = defaultDispatchDeps()): Promise<DispatchResult | null> {
  if (!DISPATCHABLE_ACTIONS.has(t.action)) return null;
  try {
    if (!(await deps.claim(t.recordId, t.teamId))) return null;
  } catch (err) {
    console.warn('[verdict-dispatch] claim failed (non-fatal):', (err as Error)?.message ?? err);
    return null;
  }
  let result: DispatchResult;
  try {
    result = await run(t, deps);
  } catch (err) {
    console.warn(`[verdict-dispatch] ${t.action} for PR #${t.prNumber} failed:`, (err as Error)?.message ?? err);
    result = skipped('dispatch_error');
  }
  await deps.settle(t.recordId, result).catch(() => {});
  return result;
}

// ── The sweep ────────────────────────────────────────────────────────────────

export interface SweepRow {
  id: string;
  teamId: string;
  workspaceId: string | null;
  taskId: string | null;
  subjectId: string | null;
  appliedAnswer: string | null;
  createdAt: Date;
}

export interface SweepDeps {
  /** Escalation-gate records filed since `sinceMs`, newest first. */
  listRecent(sinceMs: number, limit: number): Promise<SweepRow[]>;
  /** The record ids among these that already have a dispatch row. */
  dispatchedIds(ids: string[]): Promise<Set<string>>;
  dispatch(t: DispatchTarget): Promise<DispatchResult | null>;
  now(): number;
}

export interface SweepResult {
  candidates: number;
  dispatched: number;
  queued: number;
  skipped: number;
  errors: number;
}

const PR_KEY = /^pr:([^:]+):(\d+)$/;

/**
 * Dispatch every PR's newest Buildd-owned rule verdict that nothing dispatched.
 * Bounded: one page of recent records, a capped number of dispatches.
 */
export async function sweepUndispatchedEscalations(
  deps: SweepDeps = defaultSweepDeps(),
  opts: { limit?: number; maxDispatch?: number } = {},
): Promise<SweepResult> {
  const res: SweepResult = { candidates: 0, dispatched: 0, queued: 0, skipped: 0, errors: 0 };
  const nowMs = deps.now();
  const rows = await deps.listRecent(nowMs - SWEEP_WINDOW_MS, opts.limit ?? 500);
  const newest = new Map<string, SweepRow>();
  for (const r of rows) if (r.subjectId && !newest.has(r.subjectId)) newest.set(r.subjectId, r);

  const due: Array<{ row: SweepRow; target: DispatchTarget }> = [];
  for (const row of newest.values()) {
    const v = verdictFromCode(row.appliedAnswer);
    if (!v || v.owner !== 'buildd' || v.by !== 'rule' || !DISPATCHABLE_ACTIONS.has(v.action)) continue;
    if (nowMs - row.createdAt.getTime() < SWEEP_MIN_AGE_MS) continue;
    const m = PR_KEY.exec(row.subjectId ?? '');
    if (!m || !row.workspaceId) continue;
    due.push({ row, target: { recordId: row.id, teamId: row.teamId, workspaceId: row.workspaceId, prNumber: Number(m[2]), taskId: row.taskId, action: v.action } });
  }
  if (due.length === 0) return res;
  const done = await deps.dispatchedIds(due.map(d => d.row.id));
  const todo = due.filter(d => !done.has(d.row.id)).slice(0, opts.maxDispatch ?? 20);
  res.candidates = todo.length;
  for (const { target } of todo) {
    try {
      const out = await deps.dispatch(target);
      if (!out) continue;
      if (out.kind === 'dispatched') res.dispatched += 1;
      else if (out.kind === 'queued') res.queued += 1;
      else res.skipped += 1;
    } catch {
      res.errors += 1;
    }
  }
  return res;
}

// ── Defaults (db + GitHub) ───────────────────────────────────────────────────

/** The claim: one dispatch row per verdict record. Exported so a test can render it. */
export function dispatchClaimRow(recordId: string, teamId: string, now: Date) {
  return {
    decisionRecordId: recordId, teamId, capability: ESCALATION_GATE_CAPABILITY, source: DISPATCH_SOURCE,
    label: 'claimed', metadata: {}, observedAt: now,
  };
}

/** The settle's WHERE: this record's dispatch row, nothing else. Exported so a test can render it. */
export function dispatchRowWhere(recordId: string) {
  return and(eq(decisionOutcomes.decisionRecordId, recordId), eq(decisionOutcomes.source, DISPATCH_SOURCE));
}

/** The sweep's WHERE: escalation-gate records on PRs since `since`. Exported so a test can render it. */
export function recentEscalationRecordsWhere(since: Date) {
  return and(
    eq(decisionRecords.capability, ESCALATION_GATE_CAPABILITY),
    eq(decisionRecords.subjectType, 'pr'),
    gt(decisionRecords.createdAt, since),
  );
}

export function defaultDispatchDeps(): DispatchDeps {
  let ciRed: Promise<import('@/lib/ci-red-sweep').CiRedSweepDeps> | null = null;
  const ciRedDeps = () => (ciRed ??= import('@/lib/ci-red-sweep-deps').then(m => m.createCiRedSweepDeps()));
  return {
    async claim(recordId, teamId) {
      const rows = await db.insert(decisionOutcomes).values(dispatchClaimRow(recordId, teamId, new Date()))
        .onConflictDoNothing({ target: [decisionOutcomes.decisionRecordId, decisionOutcomes.source] })
        .returning({ id: decisionOutcomes.id });
      return rows.length > 0;
    },
    async settle(recordId, result) {
      await db.update(decisionOutcomes)
        .set({ label: result.kind, metadata: result as unknown as Record<string, unknown>, observedAt: new Date() })
        .where(dispatchRowWhere(recordId));
    },
    resolve: async (workspaceId, prNumber) => (await ciRedDeps()).resolveTarget({ workspaceId, prNumber }),
    peek: async target => (await ciRedDeps()).peek(target),
    retryCi: async input => (await import('@/lib/ci-failure-retry')).retryCiFailureForPr(input),
    conflictRetry: async params => (await import('@/lib/conflict-retry')).dispatchConflictRetry(params),
    renumber: async params => (await import('@/lib/migration-collision-retry')).tryDispatchMigrationCollisionRetry(params),
    async collisionReason(taskId) {
      if (!taskId) return null;
      const [row] = await db.select({ reason: gateEvents.reason }).from(gateEvents)
        .where(and(eq(gateEvents.taskId, taskId), eq(gateEvents.gate, 'pr_landing')))
        .orderBy(desc(gateEvents.occurredAt)).limit(1);
      // The newest landing event; only a collision reason is useful here.
      return row?.reason && /^migration number collision:/.test(row.reason) ? row.reason : null;
    },
    async prState(target, prNumber) {
      const { githubApi } = await import('@/lib/github');
      try {
        const pr = (await githubApi(target.installationId, `/repos/${target.repoFullName}/pulls/${prNumber}`)) as { state?: string; merged?: boolean };
        return pr.merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed';
      } catch {
        return null;
      }
    },
    async markLandingDue(member) {
      const [{ markDue }, { PR_LANDING_DUE_QUEUE }] = await Promise.all([import('@/lib/redis'), import('@/lib/pr-landing-sweep')]);
      await markDue(PR_LANDING_DUE_QUEUE, member, Date.now());
    },
    policyMerge: async p => (await import('./merge-policy-rule-executor')).runPolicyMerge(p),
  };
}

export function defaultSweepDeps(): SweepDeps {
  const dispatchDeps = defaultDispatchDeps();
  return {
    async listRecent(sinceMs, limit) {
      return db.select({
        id: decisionRecords.id, teamId: decisionRecords.teamId, workspaceId: decisionRecords.workspaceId, taskId: decisionRecords.taskId,
        subjectId: decisionRecords.subjectId, appliedAnswer: decisionRecords.appliedAnswer, createdAt: decisionRecords.createdAt,
      }).from(decisionRecords).where(recentEscalationRecordsWhere(new Date(sinceMs)))
        .orderBy(desc(decisionRecords.createdAt)).limit(limit);
    },
    async dispatchedIds(ids) {
      if (ids.length === 0) return new Set();
      const rows = await db.select({ id: decisionOutcomes.decisionRecordId }).from(decisionOutcomes)
        .where(and(inArray(decisionOutcomes.decisionRecordId, ids), eq(decisionOutcomes.source, DISPATCH_SOURCE)));
      return new Set(rows.map(r => r.id));
    },
    dispatch: t => dispatchVerdictAction(t, dispatchDeps),
    now: () => Date.now(),
  };
}
