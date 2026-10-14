/**
 * What the task page (/app/tasks/[id]) and the mission task sheet both render
 * for a task's PR, header and summary, decided once. Pure and client-safe: the
 * page calls it on the server, `/api/tasks/[id]/summary` calls it for the sheet.
 */
import { isTerminalTaskStatus } from '@buildd/shared';
import { resolvePrDisplayState, type PrDisplayState } from '@/lib/pr-presentation';
import { deriveTaskChecks, type ReviewFindings, type TaskChecks } from '@/lib/task-checks';
import type { TaskDeliveryContext } from '@/lib/task-delivery-context';
import type { DeliveryPillState } from '@/app/app/(protected)/tasks/[id]/TaskSidePanel';

export interface TaskPrWorkerLike {
  prUrl: string | null;
  prNumber: number | null;
  prLifecycleStatus: string | null;
  mergedAt: unknown;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  filesChanged?: number | null;
}

/** The PR card's stored facts: what renders before (or without) GitHub. */
export interface TaskPrFacts {
  prUrl: string;
  prNumber: number;
  prLifecycleStatus: string | null;
  prState: PrDisplayState;
  linesAdded: number | null;
  linesRemoved: number | null;
  filesChanged: number | null;
}

/**
 * The PR card's facts for the task's PR worker (`TaskView.prWorker`), or null
 * when there is no PR or it was closed. A kernel-owned PR's state is its
 * delivery's (§13.10); a merge stamp reads as merged whatever the column says.
 */
export function taskPrFacts(
  worker: TaskPrWorkerLike | null | undefined,
  delivery?: { prState?: PrDisplayState | null } | null,
): TaskPrFacts | null {
  if (!worker?.prUrl || !worker.prNumber) return null;
  const prState = resolvePrDisplayState({ delivery, prLifecycleStatus: worker.prLifecycleStatus, mergedAt: worker.mergedAt });
  if (prState === 'closed') return null;
  return {
    prUrl: worker.prUrl,
    prNumber: worker.prNumber,
    prLifecycleStatus: worker.mergedAt ? 'merged' : worker.prLifecycleStatus,
    prState,
    linesAdded: worker.linesAdded ?? null,
    linesRemoved: worker.linesRemoved ?? null,
    filesChanged: worker.filesChanged ?? null,
  };
}

/** The header reads "Merged" once the task has ended and its PR merged. */
export function taskHeaderMerged(
  worker: Pick<TaskPrWorkerLike, 'prLifecycleStatus' | 'mergedAt'> | null | undefined,
  taskStatus: string,
): boolean {
  return !!worker && !!(worker.mergedAt || worker.prLifecycleStatus === 'merged') && isTerminalTaskStatus(taskStatus);
}

/** The summary was taken from the worker's last message, not written by it. */
export function isFallbackSummary(result: { summarySource?: unknown } | null | undefined): boolean {
  return result?.summarySource === 'fallback';
}

/** The checks list's props, JSON-safe so the sheet can fetch them. */
export interface TaskChecksSection {
  checks: TaskChecks;
  prNumber: number | null;
  prUrl: string | null;
  headSha: string | null;
  /** reviewer task id → its findings. */
  findings: Record<string, ReviewFindings>;
  findingsUnavailable: boolean;
}

/**
 * The header's delivery reading and the checks list, from the delivery a task
 * belongs to (lib/task-delivery-context.ts). Null halves for a legacy or
 * PR-less task, which keeps its own status.
 */
export function taskDeliverySections(
  ctx: Pick<TaskDeliveryContext, 'view' | 'findings' | 'findingsUnavailable'>,
  prWorker: { prUrl: string | null } | null | undefined,
): { delivery: DeliveryPillState | null; checks: TaskChecksSection | null } {
  const v = ctx.view;
  if (!v) return { delivery: null, checks: null };
  const prUrl = prWorker?.prUrl
    ?? (v.repoFullName && v.prNumber != null ? `https://github.com/${v.repoFullName}/pull/${v.prNumber}` : null);
  return {
    delivery: { headline: v.headline, owner: v.owner, needsYou: v.needsYou, stage: v.stage, detail: v.detail, prState: v.prState, state: v.state },
    checks: {
      checks: deriveTaskChecks(v),
      prNumber: v.prNumber,
      prUrl,
      headSha: v.headSha,
      findings: Object.fromEntries(ctx.findings),
      findingsUnavailable: ctx.findingsUnavailable,
    },
  };
}
