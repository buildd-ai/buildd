/**
 * When may a conflict or migration repair attempt report `completed`?
 *
 * Only on evidence read from the PR it was filed for, never on the attempt's
 * own account. Before this, a legacy (non-kernel) conflict retry completed
 * after starting fresh from trunk and touching nothing on the PR. Its summary
 * said the conflict was resolved, the PR stayed dirty, and nothing compared
 * heads. docs/specs/workflow-state-kernel.md §13.11 rule 2.
 *
 * The verdict is pure. `legacyRepairCompletionGate` reads GitHub for a legacy
 * repair task, and the kernel's `fixCompletionGate` calls the same verdict for
 * its `conflict_fix` attempts, so both paths decide alike.
 */
/** The live PR read this verdict needs (structurally the kernel's `LivePr`). */
export interface RepairLivePr {
  state: 'open' | 'closed';
  merged: boolean;
  headSha: string;
  baseRef?: string | null;
  mergeableState?: string | null;
}

export type RepairKind = 'conflict' | 'migration';

export type RepairCompletionVerdict =
  | { ok: true; evidence: 'head_advanced' | 'no_repair_needed' | 'pr_not_open' | 'unverifiable' }
  | {
      ok: false;
      code: 'repair_not_advanced' | 'repair_still_conflicted' | 'repair_still_colliding';
      error: string;
      hint: string;
      boundHeadSha: string | null;
      liveHeadSha: string;
    };

/**
 * GitHub mergeable states that verify a conflict is gone. `unknown` is not
 * among them: GitHub reports it while it recomputes, so it proves nothing.
 */
const CONFLICT_FREE = new Set(['clean', 'unstable', 'has_hooks', 'blocked', 'behind']);

export function repairCompletionVerdict(p: {
  kind: RepairKind;
  prNumber: number;
  boundHeadSha: string | null;
  live: RepairLivePr | null;
  /** Migration only: does the collision still hold at the live head? null = not read. */
  collisionPresent?: boolean | null;
  localHeadSha?: string | null;
}): RepairCompletionVerdict {
  const { live, prNumber } = p;
  // Fails open when GitHub cannot be read, as the kernel gate always has.
  if (!live) return { ok: true, evidence: 'unverifiable' };
  if (live.state !== 'open' || live.merged) return { ok: true, evidence: 'pr_not_open' };

  const base = { boundHeadSha: p.boundHeadSha, liveHeadSha: live.headSha };
  const local = p.localHeadSha && p.localHeadSha !== live.headSha ? ` Your local head is ${p.localHeadSha.slice(0, 7)}.` : '';
  const state = live.mergeableState ?? null;

  if (p.kind === 'conflict' && state === 'dirty') {
    return {
      ok: false,
      code: 'repair_still_conflicted',
      error: `PR #${prNumber} still conflicts with its base: GitHub reports mergeable_state "dirty" at ${live.headSha.slice(0, 7)}.${local}`,
      hint: "Fetch the PR's base, merge it into the PR's head branch, resolve every conflict, push, then complete again.",
      ...base,
    };
  }
  if (p.kind === 'migration' && p.collisionPresent === true) {
    return {
      ok: false,
      code: 'repair_still_colliding',
      error: `PR #${prNumber}'s migration still collides at ${live.headSha.slice(0, 7)}.${local}`,
      hint: 'Merge the base in, regenerate the migration at the next free index (cd packages/core && bun db:generate), push, then complete again.',
      ...base,
    };
  }

  if (!p.boundHeadSha || live.headSha !== p.boundHeadSha) return { ok: true, evidence: 'head_advanced' };

  // Head unchanged: allowed only when the PR is verifiably fine as it stands.
  if (p.kind === 'conflict' && state && CONFLICT_FREE.has(state)) return { ok: true, evidence: 'no_repair_needed' };
  if (p.kind === 'migration' && p.collisionPresent === false) return { ok: true, evidence: 'no_repair_needed' };

  return {
    ok: false,
    code: 'repair_not_advanced',
    error: `Your repair is not on PR #${prNumber}: its head is still ${live.headSha.slice(0, 7)}, the commit this attempt was filed for, `
      + `and GitHub does not show the ${p.kind === 'migration' ? 'collision' : 'conflict'} as resolved.${local}`,
    hint: "Push to the PR's own head branch (git push origin HEAD:<head branch>), confirm with git ls-remote that the PR head moved, then complete again.",
    ...base,
  };
}

/** The repair a legacy task row is for, or null when it is not a conflict/migration repair. */
export function legacyRepairOf(task: {
  deliveryId?: string | null;
  conflictRetryPrNumber?: number | null;
  conflictRetryHeadSha?: string | null;
  subjectHeadSha?: string | null;
  context?: unknown;
}): { kind: RepairKind; prNumber: number; boundHeadSha: string | null } | null {
  // Kernel-owned attempts are decided by fixCompletionGate.
  if (task.deliveryId || typeof task.conflictRetryPrNumber !== 'number') return null;
  const ctx = (task.context ?? {}) as { failureContext?: { errorType?: unknown; headSha?: unknown }; headSha?: unknown };
  const errorType = ctx.failureContext?.errorType;
  // A semantic review and a migration split end without moving the head by design.
  if (errorType === 'semantic_conflict' || errorType === 'migration_split') return null;
  const kind: RepairKind = errorType === 'migration_collision' ? 'migration' : 'conflict';
  const head = [ctx.failureContext?.headSha, task.conflictRetryHeadSha, task.subjectHeadSha, ctx.headSha]
    .find((h): h is string => typeof h === 'string' && h.length > 0) ?? null;
  return { kind, prNumber: task.conflictRetryPrNumber, boundHeadSha: head };
}

export interface LegacyRepairGateDeps {
  repoFor: (workspaceId: string) => Promise<{ installationId: number; repoFullName: string } | null>;
  readPr: (installationId: number, repoFullName: string, prNumber: number) => Promise<RepairLivePr | null>;
  /** True when the PR's migration still collides at `headSha`; null when it could not be read. */
  collisionAt: (p: { workspaceId: string; installationId: number; repoFullName: string; prNumber: number; headSha: string; baseRef: string | null }) => Promise<boolean | null>;
}

/** Refusal for a legacy conflict/migration retry, or null to allow completion. */
export async function legacyRepairCompletionGate(
  p: {
    task: { workspaceId: string; deliveryId?: string | null; conflictRetryPrNumber?: number | null; conflictRetryHeadSha?: string | null; subjectHeadSha?: string | null; context?: unknown };
    localHeadSha: string | null;
  },
  deps: LegacyRepairGateDeps,
): Promise<Extract<RepairCompletionVerdict, { ok: false }> | null> {
  const repair = legacyRepairOf(p.task);
  if (!repair) return null;
  const repo = await deps.repoFor(p.task.workspaceId);
  if (!repo) return null;
  const live = await deps.readPr(repo.installationId, repo.repoFullName, repair.prNumber);
  const collisionPresent = repair.kind === 'migration' && live && live.state === 'open' && !live.merged
    ? await deps.collisionAt({ workspaceId: p.task.workspaceId, installationId: repo.installationId, repoFullName: repo.repoFullName, prNumber: repair.prNumber, headSha: live.headSha, baseRef: live.baseRef ?? null })
    : null;
  const verdict = repairCompletionVerdict({ ...repair, live, collisionPresent, localHeadSha: p.localHeadSha });
  return verdict.ok ? null : verdict;
}

