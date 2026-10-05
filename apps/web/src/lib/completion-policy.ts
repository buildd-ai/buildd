/**
 * Completion policies: the verdicts a module contributes to a worker's
 * completion report, in slots core declares and orders. This file is the
 * contract and has no runtime imports, so modules can depend on it freely.
 * See knowledge-base: buildd/design/headless-core-and-modules.md.
 *
 * The worker PATCH (`app/api/workers/[id]/route.ts`) stays the only place
 * that decides a task's terminal status. A policy returns a verdict; the PATCH
 * applies it: the status, the task-row writes, the alerts and the refusal
 * response are core's. Policies are not subscribers. They decide outcomes, so
 * they are wired by slot in the composition root (`apps/web/src/modules.ts`
 * `COMPLETION_POLICIES`), not appended to an event list, and every slot has
 * exactly one policy.
 *
 * Slot order is fixed by core, in the order the PATCH evaluates them:
 *   1. evidence: may refuse the report (400) before anything is written;
 *   2. loop:     may requeue the task or fail it, before the task write;
 *   3. release:  runs after the task write; may fail it or hold it for CI.
 * Each verdict is pass | fail | hold, or `null` where the slot has nothing to
 * judge (no loop configured, a task the evidence policy does not own).
 */
import type { LoopHistoryEntry } from '@buildd/shared';
import type { ReleaseResult } from '@buildd/core/db/schema';

export const COMPLETION_SLOTS = ['evidence', 'loop', 'release'] as const;
export type CompletionSlot = (typeof COMPLETION_SLOTS)[number];

// ── evidence ───────────────────────────────────────────────────────────────
export interface EvidenceInput {
  workerId: string;
  taskId: string;
  missionId: string | null;
  workspaceId: string;
  roleSlug: string | null;
  workerStartedAt: Date | string | null;
}
/**
 * `null`: not this policy's task; the output-requirement gates apply as usual.
 * `pass`: the evidence IS the deliverable. It replaces the output-requirement
 *   gates, and there is nothing to release.
 * `fail`: the report is refused with `reason`; nothing is written. `hint`
 *   labels the refusal for the runner and the rejected-payload record.
 */
export type EvidenceVerdict = null | { kind: 'pass' } | { kind: 'fail'; reason: string; hint: string };

// ── loop ───────────────────────────────────────────────────────────────────
export interface LoopInput {
  taskId: string;
  workerId: string;
  workerBranch: string | null;
  workerLastCommitSha: string | null;
  verificationEvidence: unknown;
  structuredOutput: unknown;
}
export interface LoopProgress { iteration: number; history: LoopHistoryEntry[] }
/**
 * `null`: no loop configured.
 * `pass`: the exit condition holds; completion continues.
 * `hold`: condition unmet with attempts left: the task goes back to pending
 *   with `retryContext` as its context, not before `startAt` when set.
 * `fail`: attempts exhausted; the task fails with `reason`.
 */
export type LoopVerdict =
  | null
  | { kind: 'pass'; progress: LoopProgress }
  | { kind: 'hold'; until: 'requeue'; progress: LoopProgress; startAt: Date | null; retryContext: Record<string, unknown> }
  | { kind: 'fail'; reason: string; progress: LoopProgress };

// ── release ────────────────────────────────────────────────────────────────
export interface ReleaseInput {
  taskId: string;
  workerId: string;
  workspaceId: string;
  missionId: string | null;
}
/**
 * Every verdict carries the release `record` (stored on the task) and a
 * one-line `summary` (merged into the task result).
 * `pass`: released, skipped, or no release configured.
 * `fail`: the task flips to failed; `reason` and `prUrl` go in the alert.
 * `hold`: the release PR waits on CI; the check_suite webhook settles it.
 */
export type ReleaseVerdict =
  | { kind: 'pass'; record: ReleaseResult; summary: string }
  | { kind: 'fail'; record: ReleaseResult; summary: string; reason: string; prUrl: string | undefined }
  | { kind: 'hold'; until: 'ci'; record: ReleaseResult; summary: string; prNumber: number | undefined; prUrl: string | undefined };

export interface ReleasePolicy {
  evaluate(input: ReleaseInput): Promise<ReleaseVerdict>;
  /** After the verdict is applied, whatever it was (or if evaluate threw). Fire-and-forget. */
  settled(input: ReleaseInput): void;
}

export interface CompletionPolicies {
  evidence(input: EvidenceInput): Promise<EvidenceVerdict>;
  loop(input: LoopInput): Promise<LoopVerdict>;
  release: ReleasePolicy;
}
