/**
 * The escalation gate's input, built from what the PR inbox already loads
 * (lib/pr-attention.ts, Home's page). One builder, so Home, the badge,
 * list_prs and the escalation pushes describe a PR to the gate the same way.
 */
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { gateEvents } from '@buildd/core/db/schema';
import type { CiState, EscalationSubject, EscalationWhy } from '@buildd/core/escalation-gate';
import type { GatedSubject } from '@/lib/escalation-gate-check';

/** How far back a landing deferral still describes the PR. */
const LANDING_STALL_WINDOW_MS = 24 * 60 * 60_000;

export type LandingStall = 'migration_collision' | 'stranded';

/** The last pr_landing gate event's reason, as a stall the gate names. Pure. */
export function landingStallOf(e: { outcome: string; reason: string } | null | undefined): LandingStall | null {
  if (!e) return null;
  if (/^migration number collision\b/i.test(e.reason)) return 'migration_collision';
  if (e.outcome === 'stranded') return 'stranded';
  return null;
}

/** The pr_landing events' WHERE (exported so a test can render it). */
export function landingStallWhere(taskIds: string[], since: Date) {
  return and(inArray(gateEvents.taskId, taskIds), eq(gateEvents.gate, 'pr_landing'), gte(gateEvents.occurredAt, since));
}

/** taskId → the stall its newest landing look recorded, for these tasks. Never throws. */
export async function loadLandingStalls(taskIds: string[], nowMs: number = Date.now()): Promise<Map<string, LandingStall>> {
  const out = new Map<string, LandingStall>();
  if (taskIds.length === 0) return out;
  try {
    const rows = await db
      .select({ taskId: gateEvents.taskId, outcome: gateEvents.outcome, reason: gateEvents.reason })
      .from(gateEvents)
      .where(landingStallWhere(taskIds, new Date(nowMs - LANDING_STALL_WINDOW_MS)))
      .orderBy(desc(gateEvents.occurredAt))
      .limit(taskIds.length * 8);
    const seen = new Set<string>();
    for (const r of rows) {
      if (!r.taskId || seen.has(r.taskId)) continue;
      seen.add(r.taskId);
      const stall = landingStallOf(r);
      if (stall) out.set(r.taskId, stall);
    }
  } catch (err) {
    console.warn('[escalation-subjects] landing stall read failed (non-fatal):', (err as Error)?.message ?? err);
  }
  return out;
}

/** The PR's checks, from the delivery's PR state when the kernel owns it, else the lifecycle column. Pure. */
export function ciStateOf(lifecycle: string | null | undefined, kernelPrState?: string | null): CiState {
  const s = kernelPrState ?? lifecycle ?? null;
  switch (s) {
    case 'ci_failed': return 'red';
    case 'ci_green':
    case 'ci_passed': return 'green';
    case 'ci_running':
    case 'awaiting_ci': return 'running';
    default: return 'unknown';
  }
}

export interface PrSubjectInput {
  teamId: string;
  sensitive: boolean;
  workspaceId: string;
  prNumber: number | null;
  taskId: string | null;
  task: { title?: string | null; missionId?: string | null } | null;
  /** `missionPrRoleOf` (lib/action-queue.ts) for the PR's task, computed by the caller. */
  missionPrRole: 'ship' | 'refresh' | null;
  lifecycle: string | null;
  headSha?: string | null;
  /** The kernel's view of the delivery, when the kernel owns it. */
  kernel?: { stateReason: string | null; prState: string | null; detail: string | null; headline: string | null } | null;
  escalated: { reason?: string | null } | null;
  approved: boolean;
  handoff: { cause: string; reason: string } | null;
  conflictFixesSpent: boolean;
  /** A conflict repair, CI or review fix, running checks or a reviewer agent is live. */
  machineActing: boolean;
  landingStall: LandingStall | null;
}

const KERNEL_WHY: Record<string, EscalationWhy> = {
  review_escalated: 'reviewer_escalated',
  review_exhausted: 'review_exhausted',
  landing_needs_human: 'landing_handoff',
};

/** One PR as the escalation gate reads it. Pure. */
export function prSubjectFor(i: PrSubjectInput): GatedSubject {
  const why: EscalationWhy = i.conflictFixesSpent ? 'conflict_fixes_spent'
    : i.handoff ? 'landing_handoff'
    : i.kernel ? (KERNEL_WHY[i.kernel.stateReason ?? ''] ?? 'kernel_needs_you')
    : i.escalated ? 'reviewer_escalated'
    : i.approved ? 'approved_needs_merge'
    : 'human_tier';
  const prState = i.kernel?.prState ?? null;
  const conflict = prState === 'conflict' || (!prState && i.lifecycle === 'conflict');
  const subject: EscalationSubject = {
    key: i.prNumber != null ? `pr:${i.workspaceId}:${i.prNumber}` : `task:${i.taskId ?? 'none'}`,
    workspaceId: i.workspaceId,
    prNumber: i.prNumber,
    taskId: i.taskId,
    missionId: i.task?.missionId ?? null,
    title: i.task?.title ?? '',
    why,
    ci: ciStateOf(i.lifecycle, prState),
    conflict,
    machineActing: i.machineActing,
    missionPrRole: i.missionPrRole,
    handoffCause: i.handoff?.cause ?? null,
    handoffReason: i.handoff?.reason ?? null,
    detail: i.escalated?.reason ?? i.kernel?.detail ?? i.kernel?.headline ?? null,
    migrationCollision: i.landingStall === 'migration_collision',
    landingStranded: i.landingStall === 'stranded',
    headSha: i.headSha ?? null,
  };
  return { ...subject, teamId: i.teamId, sensitive: i.sensitive };
}
