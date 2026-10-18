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


// ── Legacy review fix (a PR with no delivery) ───────────────────────────────

export type LegacyReviewFixRefusal = {
  code: 'delivery_not_advanced' | 'repair_unrelated_diff';
  error: string;
  hint: string;
  boundHeadSha: string | null;
  liveHeadSha: string;
};

/** The review round a legacy fix answers, or null when the task is not one (kernel fixes are gated by `fixCompletionGate`). */
export function legacyReviewFixOf(task: {
  deliveryId?: string | null;
  reviewerRetryPrNumber?: number | null;
  reviewerRetryHeadSha?: string | null;
  context?: unknown;
}): { prNumber: number; boundHeadSha: string; feedback: string | null; human: boolean } | null {
  if (task.deliveryId || typeof task.reviewerRetryPrNumber !== 'number' || !task.reviewerRetryHeadSha) return null;
  const fc = ((task.context ?? {}) as { failureContext?: { errorType?: unknown; summary?: unknown } }).failureContext;
  if (fc?.errorType !== 'reviewer_request_changes' && fc?.errorType !== 'reviewer_escalation_applied') return null;
  return {
    prNumber: task.reviewerRetryPrNumber, boundHeadSha: task.reviewerRetryHeadSha,
    feedback: typeof fc.summary === 'string' ? fc.summary : null,
    // A person's fix (Apply recommendation) is theirs to judge: head-moved only, no relevance check.
    human: fc.errorType === 'reviewer_escalation_applied',
  };
}

export interface LegacyReviewFixGateDeps {
  repoFor: LegacyRepairGateDeps['repoFor'];
  readPr: LegacyRepairGateDeps['readPr'];
  /** Paths changed between two commits; null when unreadable or cut off. */
  changedPaths: (p: { installationId: number; repoFullName: string; fromSha: string; toSha: string }) => Promise<string[] | null>;
  /** Paths the review's inline comments were anchored to at `headSha`. */
  findingPaths: (p: { workspaceId: string; repoFullName: string; prNumber: number; headSha: string }) => Promise<string[]>;
  /** The kernel's relevance rule (reached through the workflow seam): false only when the diff plainly misses every named path. */
  diffTouches: (p: { named: string[]; changed: string[] | null; feedback: string | null }) => boolean | null;
}

/**
 * Same rule as the kernel's `fixCompletionGate` for a review fix (§13.13 rule 4), for a PR with no
 * delivery: the head must have moved, and the push must change something near what the review
 * names. An unmoved head passes only with a no-op claim, which the next review verifies. Fails open
 * when GitHub cannot be read or the review named no path.
 */
export async function legacyReviewFixCompletionGate(
  p: {
    task: { workspaceId: string; deliveryId?: string | null; reviewerRetryPrNumber?: number | null; reviewerRetryHeadSha?: string | null; context?: unknown };
    localHeadSha: string | null;
    noopClaimed?: boolean;
    /** A well-formed `fixedElsewhere` claim (files and reason); the next review verifies it. */
    fixedElsewhere?: { files: string[]; reason: string } | null;
  },
  deps: LegacyReviewFixGateDeps,
): Promise<LegacyReviewFixRefusal | null> {
  const fix = legacyReviewFixOf(p.task);
  if (!fix) return null;
  const repo = await deps.repoFor(p.task.workspaceId);
  if (!repo) return null;
  const live = await deps.readPr(repo.installationId, repo.repoFullName, fix.prNumber);
  if (!live || live.state !== 'open' || live.merged) return null;
  const base = { boundHeadSha: fix.boundHeadSha, liveHeadSha: live.headSha };
  if (live.headSha === fix.boundHeadSha) {
    if (p.noopClaimed) return null;
    const local = p.localHeadSha && p.localHeadSha !== live.headSha ? ` Your local head is ${p.localHeadSha.slice(0, 7)}.` : '';
    return {
      code: 'delivery_not_advanced',
      error: `Your fix is not on GitHub: PR #${fix.prNumber}'s head is still ${live.headSha.slice(0, 7)}, the commit the review asked you to change.${local}`,
      hint: 'Push your branch (git push), confirm with git ls-remote that the PR head moved, then complete again.',
      ...base,
    };
  }
  if (fix.human || p.fixedElsewhere) return null;
  const named = await deps.findingPaths({ workspaceId: p.task.workspaceId, repoFullName: repo.repoFullName, prNumber: fix.prNumber, headSha: fix.boundHeadSha });
  const changed = await deps.changedPaths({ installationId: repo.installationId, repoFullName: repo.repoFullName, fromSha: fix.boundHeadSha, toSha: live.headSha }).catch(() => null);
  if (named.length === 0) {
    // No anchored finding: only an empty diff is plainly not a fix.
    if (changed && changed.length === 0) return unrelated(fix.prNumber, [], base);
    return null;
  }
  if (deps.diffTouches({ named, changed, feedback: fix.feedback }) === false) return unrelated(fix.prNumber, named, base);
  return null;
}

function unrelated(prNumber: number, named: string[], base: { boundHeadSha: string; liveHeadSha: string }): LegacyReviewFixRefusal {
  return {
    code: 'repair_unrelated_diff',
    error: named.length
      ? `Your push to PR #${prNumber} changes nothing near the files the review names (${[...new Set(named)].slice(0, 5).join(', ')}), nor anything its feedback names.`
      : `Your push to PR #${prNumber} changes no files.`,
    hint: 'Fix what the review asked for and push. If the fix belongs elsewhere, complete with structuredOutput.fixedElsewhere { findingIds, files, reason } naming the files you changed and why; the re-review verifies it.',
    ...base,
  };
}
