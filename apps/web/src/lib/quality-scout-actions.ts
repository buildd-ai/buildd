/**
 * Quality Scout — the deduped follow-up policy (artifact
 * workspace-quality-scout-spec §10–§11).
 *
 * The ledger (`@buildd/core/quality-scout/ledger`) folds every `fail` into one
 * finding per (workspace, signature). This module decides what that finding
 * is owed, and files at most one task for it:
 *
 *  - **critical / high** with verified evidence (evidence refs AND confidence
 *    at or above `minConfidence`) → one follow-up: a fix when the failure
 *    reproduced deterministically, an investigation otherwise.
 *  - **medium** aggregates, unless it is recurrent (seen `count` times, the
 *    last inside `windowDays`, or it regressed after a resolve) or reproduced
 *    deterministically — then it is treated like high.
 *  - **low** is retained only.
 *  - **inconclusive / unsupported** never reach here: only `fail` creates a
 *    finding, so missing evidence or capability cannot file a defect.
 *
 * Mode: `shadow` records the would-be follow-up as `proposed` and files
 * nothing; `propose` files; `off` does nothing.
 *
 * ── Dedupe ──
 * The doc-fix pattern (lib/doc-fix-dispatch.ts): insert the task, then take
 * the claim with one atomic `UPDATE … WHERE action_task_id IS NULL` (or the
 * dead task being taken over). The loser deletes its still-pending task before
 * anything announces it, so concurrent runs on one finding file one task. A
 * finding whose task is still live gets that task refreshed instead.
 *
 * Nothing here edits code, merges, or writes memory: the only writes are the
 * finding's action columns and the follow-up task row.
 */

import { db } from '@buildd/core/db';
import { qualityScoutFindings, tasks, workspaces } from '@buildd/core/db/schema';
import type { VerificationSeverity } from '@buildd/core/verification-check';
import type {
  ScoutActionOutcome,
  ScoutActionState,
  ScoutFinding,
  ScoutMode,
  ScoutRun,
} from '@buildd/core/quality-scout/types';
import { and, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { isTerminalTaskStatus, TERMINAL_TASK_STATUSES } from '@buildd/shared';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { pickEffectiveRole } from '@/lib/effective-roles';

// ── Policy config ───────────────────────────────────────────────────────────

export interface ScoutActionPolicy {
  /** A finding files only at or above this confidence (with evidence refs). */
  minConfidence: number;
  /** A medium finding files once seen `count` times, the last inside `windowDays`. */
  mediumRecurrence: { count: number; windowDays: number };
}

export const DEFAULT_SCOUT_ACTION_POLICY: ScoutActionPolicy = {
  minConfidence: 0.7,
  mediumRecurrence: { count: 2, windowDays: 7 },
};

const MAX_RECURRENCE_COUNT = 50;
const MAX_WINDOW_DAYS = 90;

const inRange = (n: unknown, lo: number, hi: number): n is number => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * `gitConfig.qualityScout` → thresholds. Each field falls back independently;
 * an out-of-range value is ignored rather than clamped, so a typo cannot make
 * the policy more eager. `minConfidence` must be above 0: zero would let a
 * fail with no confidence at all file a task.
 */
export function resolveScoutActionPolicy(raw: unknown): ScoutActionPolicy {
  const d = DEFAULT_SCOUT_ACTION_POLICY;
  const policy = isRecord(raw) && isRecord(raw.policy) ? raw.policy : {};
  const rec = isRecord(policy.mediumRecurrence) ? policy.mediumRecurrence : {};
  return {
    minConfidence: inRange(policy.minConfidence, 0.01, 1) ? policy.minConfidence : d.minConfidence,
    mediumRecurrence: {
      count: inRange(rec.count, 1, MAX_RECURRENCE_COUNT) && Number.isInteger(rec.count) ? rec.count : d.mediumRecurrence.count,
      windowDays: inRange(rec.windowDays, 1, MAX_WINDOW_DAYS) ? rec.windowDays : d.mediumRecurrence.windowDays,
    },
  };
}

// ── Decision (pure) ─────────────────────────────────────────────────────────

export type ScoutFollowUpKind = 'fix' | 'investigate';

export type ScoutActionDecision =
  | { kind: 'file'; reason: string; followUp: ScoutFollowUpKind }
  | { kind: 'propose'; reason: string; followUp: ScoutFollowUpKind }
  | { kind: 'aggregate'; reason: string }
  | { kind: 'retain'; reason: string }
  | { kind: 'none'; reason: string };

export interface ScoutActionContext {
  mode: ScoutMode;
  policy: ScoutActionPolicy;
  now: Date;
}

/** Evidence a person can open, from an executor that was confident. */
export function hasVerifiedEvidence(f: Pick<ScoutFinding, 'evidenceRefs' | 'confidence'>, policy: ScoutActionPolicy): boolean {
  return f.evidenceRefs.length > 0 && f.confidence !== null && f.confidence >= policy.minConfidence;
}

function isRecurrent(f: ScoutFinding, policy: ScoutActionPolicy, now: Date): boolean {
  if (f.regressionCount > 0) return true;
  const windowStart = now.getTime() - policy.mediumRecurrence.windowDays * 24 * 3_600_000;
  return f.occurrenceCount >= policy.mediumRecurrence.count && Date.parse(f.lastSeenAt) >= windowStart;
}

export function decideScoutAction(f: ScoutFinding, ctx: ScoutActionContext): ScoutActionDecision {
  if (ctx.mode === 'off') return { kind: 'none', reason: 'mode_off' };
  if (f.state !== 'open') return { kind: 'none', reason: `finding_${f.state}` };
  if (f.severity === 'low') return { kind: 'retain', reason: 'low_severity' };
  if (!hasVerifiedEvidence(f, ctx.policy)) return { kind: 'aggregate', reason: 'insufficient_evidence' };

  let reason: string;
  if (f.severity === 'critical' || f.severity === 'high') {
    reason = `${f.severity}_verified`;
  } else if (f.reproducibility === 'deterministic') {
    reason = 'medium_deterministic';
  } else if (isRecurrent(f, ctx.policy, ctx.now)) {
    reason = 'medium_recurrent';
  } else {
    return { kind: 'aggregate', reason: 'medium_awaiting_recurrence' };
  }
  const followUp: ScoutFollowUpKind = f.reproducibility === 'deterministic' ? 'fix' : 'investigate';
  return ctx.mode === 'shadow' ? { kind: 'propose', reason, followUp } : { kind: 'file', reason, followUp };
}

// ── Follow-up task ──────────────────────────────────────────────────────────

const MAX_TITLE = 120;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function scoutFollowUpTitle(f: ScoutFinding, kind: ScoutFollowUpKind): string {
  const subject = f.invariant.replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  return clip(kind === 'fix' ? `fix(scout): ${subject}` : `chore(scout): investigate — ${subject}`, MAX_TITLE);
}

/** Priority by severity; a recurrence only ever raises it. */
export const SCOUT_FOLLOW_UP_PRIORITY: Record<VerificationSeverity, number> = { critical: 8, high: 6, medium: 4, low: 2 };

export function buildScoutFollowUpDescription(f: ScoutFinding, run: ScoutRun, kind: ScoutFollowUpKind): string {
  const lines = [
    kind === 'fix'
      ? 'Quality Scout found a broken invariant that reproduces deterministically. Fix it, with a regression test.'
      : 'Quality Scout saw this invariant fail, but could not show it reproduces every time. Investigate: confirm or rule it out before changing code.',
    '',
    `**Invariant (declared before the probe ran):** ${f.invariant}`,
    `**Observed:** ${f.observed ?? '(no observation recorded)'}`,
    `**Severity:** ${f.severity} · **confidence:** ${f.confidence ?? 'n/a'} · **reproducibility:** ${f.reproducibility}`,
    `**Exercised:** \`${run.candidate.ref}\` at \`${run.candidate.sha}\` (run ${run.id.slice(0, 8)})`,
    `**Seen:** ${f.occurrenceCount} time(s) since ${f.firstSeenAt}${f.regressionCount > 0 ? `, regressed ${f.regressionCount} time(s) after a fix` : ''}`,
    '',
    '**Evidence:**',
    ...(f.evidenceRefs.length > 0 ? f.evidenceRefs.map((e) => `- ${e.kind}: ${e.ref}`) : ['- (none)']),
    '',
    `Finding signature: \`${f.signature}\` (check \`${f.checkId}\`). Later Scout runs update this task instead of filing another;`,
    'a passing run of the same check resolves the finding and cancels this task if nobody has claimed it yet.',
    'The Scout is advisory: nothing blocks on this task.',
  ];
  return lines.join('\n');
}

// ── Store ───────────────────────────────────────────────────────────────────

export interface ScoutFollowUpTaskInput {
  workspaceId: string;
  signature: string;
  title: string;
  description: string;
  priority: number;
  category: 'bug';
  kind: ScoutFollowUpKind;
  runId: string;
  missionId: string | null;
  /** The ended task this one takes over from, when the finding outlived it. */
  followUpOf: string | null;
}

export interface ScoutActionStore {
  /** Atomic: raise `action_state` to `to` only from a lower state. False when already at/above it. */
  raiseActionState(workspaceId: string, signature: string, to: Exclude<ScoutActionState, 'none' | 'filed'>): Promise<boolean>;
  /** The task's status, or null when it no longer exists. */
  taskStatus(taskId: string): Promise<string | null>;
  /** Insert a pending task. Not announced: nothing may start on it before the claim. */
  insertTask(input: ScoutFollowUpTaskInput): Promise<{ id: string }>;
  /** Atomic claim: set `filed` + task iff the finding has no task, or one of `takeover`. */
  claimFollowUp(workspaceId: string, signature: string, taskId: string, takeover: string[]): Promise<boolean>;
  currentTaskId(workspaceId: string, signature: string): Promise<string | null>;
  /** Delete a task that lost the claim. Only ever a still-pending row. */
  deleteTask(taskId: string): Promise<void>;
  /** Fold the latest occurrence into the live task. */
  refreshTask(taskId: string, f: ScoutFinding, run: ScoutRun): Promise<boolean>;
  /** Announce and wake a task that won the claim. */
  announce(taskId: string): Promise<void>;
  /**
   * The finding resolved: cancel the follow-up if nobody has claimed it yet,
   * otherwise mark it resolved and drop its priority. Null when the task is
   * gone or already ended.
   */
  retireFollowUp(taskId: string, run: ScoutRun): Promise<'cancelled' | 'annotated' | null>;
}


const STATE_FOR: Record<'propose' | 'aggregate' | 'retain', Exclude<ScoutActionState, 'none' | 'filed'>> = {
  propose: 'proposed',
  aggregate: 'aggregated',
  retain: 'retained',
};
const OUTCOME_FOR: Record<'propose' | 'aggregate' | 'retain', ScoutActionOutcome> = {
  propose: 'proposed',
  aggregate: 'aggregated',
  retain: 'retained',
};

export interface ScoutActionResult {
  decision: ScoutActionDecision;
  outcome: ScoutActionOutcome;
  /** The task that now covers the finding, if any. */
  taskId: string | null;
}

/**
 * Apply the policy to one finding (as just written by the ledger). Never
 * throws: a store error is `failed`, and the run carries on.
 */
export async function actOnScoutFinding(
  f: ScoutFinding,
  run: ScoutRun,
  ctx: ScoutActionContext,
  store: ScoutActionStore = dbScoutActionStore,
): Promise<ScoutActionResult> {
  const decision = decideScoutAction(f, ctx);
  try {
    if (decision.kind === 'none') return { decision, outcome: 'noop', taskId: f.actionTaskId };

    if (decision.kind !== 'file') {
      const raised = await store.raiseActionState(f.workspaceId, f.signature, STATE_FOR[decision.kind]);
      if (raised) return { decision, outcome: OUTCOME_FOR[decision.kind], taskId: f.actionTaskId };
      // Already proposed (or filed): the would-be follow-up is a duplicate.
      return { decision, outcome: decision.kind === 'propose' ? 'suppressed' : 'noop', taskId: f.actionTaskId };
    }

    // A live task already covers it: update that one.
    let takeover: string[] = [];
    if (f.actionTaskId) {
      const status = await store.taskStatus(f.actionTaskId);
      // An ended follow-up (completed/failed/cancelled) with the finding still failing is owed a fresh one.
      if (status !== null && !isTerminalTaskStatus(status)) {
        await store.refreshTask(f.actionTaskId, f, run);
        return { decision, outcome: 'updated', taskId: f.actionTaskId };
      }
      takeover = [f.actionTaskId];
    }

    const { id } = await store.insertTask({
      workspaceId: f.workspaceId,
      signature: f.signature,
      title: scoutFollowUpTitle(f, decision.followUp),
      description: buildScoutFollowUpDescription(f, run, decision.followUp),
      priority: SCOUT_FOLLOW_UP_PRIORITY[f.severity],
      category: 'bug',
      kind: decision.followUp,
      runId: run.id,
      missionId: run.missionId,
      followUpOf: takeover[0] ?? null,
    });
    if (await store.claimFollowUp(f.workspaceId, f.signature, id, takeover)) {
      await store.announce(id);
      return { decision, outcome: 'filed', taskId: id };
    }
    // Lost the race: drop ours before anything could start on it.
    await store.deleteTask(id);
    return { decision, outcome: 'suppressed', taskId: await store.currentTaskId(f.workspaceId, f.signature) };
  } catch (err) {
    console.warn('[quality-scout] follow-up action failed (non-fatal):', (err as Error)?.message ?? err);
    return { decision, outcome: 'failed', taskId: null };
  }
}

/**
 * A pass just resolved the finding: its follow-up is no longer owed. Cancel it
 * while still unclaimed; a claimed one is left to its worker but marked
 * resolved and deprioritised. Never throws.
 */
export async function retireScoutFollowUp(
  f: { actionTaskId: string | null },
  run: ScoutRun,
  store: ScoutActionStore = dbScoutActionStore,
): Promise<ScoutActionOutcome> {
  if (!f.actionTaskId) return 'noop';
  try {
    return (await store.retireFollowUp(f.actionTaskId, run)) ?? 'noop';
  } catch (err) {
    console.warn('[quality-scout] follow-up retire failed (non-fatal):', (err as Error)?.message ?? err);
    return 'failed';
  }
}

const RAISABLE_FROM: Record<Exclude<ScoutActionState, 'none' | 'filed'>, ScoutActionState[]> = {
  retained: ['none'],
  aggregated: ['none', 'retained'],
  proposed: ['none', 'retained', 'aggregated'],
};

const findingWhere = (workspaceId: string, signature: string) =>
  and(eq(qualityScoutFindings.workspaceId, workspaceId), eq(qualityScoutFindings.signature, signature));

/** The Drizzle-backed store. Every write is a single conditional UPDATE/INSERT — no interactive transaction. */
export const dbScoutActionStore: ScoutActionStore = {
  async raiseActionState(workspaceId, signature, to) {
    const rows = await db.update(qualityScoutFindings)
      .set({ actionState: to })
      .where(and(findingWhere(workspaceId, signature), inArray(qualityScoutFindings.actionState, RAISABLE_FROM[to])))
      .returning({ id: qualityScoutFindings.id });
    return rows.length > 0;
  },
  async taskStatus(taskId) {
    const row = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId), columns: { status: true } });
    return row?.status ?? null;
  },
  async insertTask(input) {
    const roleSlug = await pickEffectiveRole(input.workspaceId, ['builder']);
    const [row] = await db.insert(tasks).values({
      workspaceId: input.workspaceId,
      title: input.title,
      description: input.description,
      mode: 'execution',
      taskClass: 'work',
      outputRequirement: input.kind === 'fix' ? 'pr_required' : 'auto',
      category: input.category,
      kind: 'engineering',
      roleSlug,
      priority: input.priority,
      status: 'pending',
      creationSource: 'orchestrator',
      context: {
        qualityScout: {
          signature: input.signature,
          runId: input.runId,
          missionId: input.missionId,
          followUp: input.kind,
          ...(input.followUpOf ? { followUpOf: input.followUpOf } : {}),
        },
      },
    }).returning({ id: tasks.id });
    return { id: row.id };
  },
  async claimFollowUp(workspaceId, signature, taskId, takeover) {
    const free = takeover.length > 0
      ? or(isNull(qualityScoutFindings.actionTaskId), inArray(qualityScoutFindings.actionTaskId, takeover))
      : isNull(qualityScoutFindings.actionTaskId);
    // Not updated_at: the ledger's compare-and-set is on occurrence_count, and
    // the claim must not look like a recurrence to a concurrent writer.
    const rows = await db.update(qualityScoutFindings)
      .set({ actionState: 'filed', actionTaskId: taskId })
      .where(and(findingWhere(workspaceId, signature), free))
      .returning({ id: qualityScoutFindings.id });
    return rows.length > 0;
  },
  async currentTaskId(workspaceId, signature) {
    const [row] = await db.select({ id: qualityScoutFindings.actionTaskId }).from(qualityScoutFindings)
      .where(findingWhere(workspaceId, signature)).limit(1);
    return row?.id ?? null;
  },
  async deleteTask(taskId) {
    await db.delete(tasks).where(and(eq(tasks.id, taskId), eq(tasks.status, 'pending')));
  },
  async refreshTask(taskId, f, run) {
    const latest = {
      lastSeenRunId: run.id,
      lastSeenSha: run.candidate.sha,
      occurrenceCount: f.occurrenceCount,
      regressionCount: f.regressionCount,
      severity: f.severity,
      reproducibility: f.reproducibility,
    };
    const rows = await db.update(tasks)
      .set({
        context: sql`jsonb_set(coalesce(${tasks.context}, '{}'::jsonb), '{qualityScout,latest}', ${JSON.stringify(latest)}::jsonb, true)`,
        priority: sql`greatest(${tasks.priority}, ${SCOUT_FOLLOW_UP_PRIORITY[f.severity]})`,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId))
      .returning({ id: tasks.id });
    return rows.length > 0;
  },
  async announce(taskId) {
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    if (!task) return;
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, task.workspaceId) });
    if (!workspace) return;
    await announceTaskCreated(task, workspace);
    await wakeTask(task.id, 'task.created');
  },
  async retireFollowUp(taskId, run) {
    const resolved = { resolvedRunId: run.id, resolvedSha: run.candidate.sha };
    const context = sql`jsonb_set(coalesce(${tasks.context}, '{}'::jsonb), '{qualityScout,resolved}', ${JSON.stringify(resolved)}::jsonb, true)`;
    const [cancelled] = await db.update(tasks)
      .set({ status: 'cancelled', context, updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, 'pending'), isNull(tasks.claimedBy)))
      .returning({ id: tasks.id, workspaceId: tasks.workspaceId, missionId: tasks.missionId });
    if (cancelled) {
      const { applyTaskCancelSideEffects } = await import('@/lib/task-cancel');
      await applyTaskCancelSideEffects(cancelled);
      return 'cancelled';
    }
    // Claimed (or racing a claim): the worker keeps it, but it no longer outranks owed work.
    const annotated = await db.update(tasks)
      .set({ context, priority: sql`least(${tasks.priority}, ${SCOUT_FOLLOW_UP_PRIORITY.low})`, updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), notInArray(tasks.status, [...TERMINAL_TASK_STATUSES])))
      .returning({ id: tasks.id });
    return annotated.length > 0 ? 'annotated' : null;
  },
};
