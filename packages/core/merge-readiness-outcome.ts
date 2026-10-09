/**
 * Outcome labels for `buildd.merge_readiness` decisions: what actually
 * happened to the PR head a decision was asked about. Pure; the GitHub reads
 * and the ledger write live in `apps/web/src/lib/merge-readiness-outcomes.ts`.
 *
 * Label definitions (knowledge-base: buildd/reports/merge-readiness-backtest/README.md):
 *
 * - `merge_now`: the PR merged, and its diff at merge is the diff it had at the
 *   decision's head. What does not count as a change:
 *     - drizzle snapshot and journal files (regenerated on every renumber);
 *     - migration SQL is compared by content, not file name, so a migration
 *       renumbered to dodge an index collision is the same migration;
 *     - a file the base also changed in between is conflict resolution;
 *     - hunk headers and context lines, which shift when the branch is refreshed.
 * - `code_change`: the PR merged with a real change after the decision.
 * - `close`: the PR closed without merging.
 * - `reverted` / `not_reverted`: a separate source, attached by the sweep once
 *   the merge is `REVERT_WINDOW_MS` old (`revertOutcome`).
 *
 * A force-pushed decision head can no longer be diffed. The label then falls
 * back to the PR's commit messages after the decision and is marked
 * `confidence: 'low'`.
 */

export const MERGE_READINESS_OUTCOME_LABELS = ['merge_now', 'code_change', 'close'] as const;
export type MergeReadinessOutcomeLabel = (typeof MERGE_READINESS_OUTCOME_LABELS)[number];

export const REVERT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** One file of a PR diff, as GitHub's `pulls/{n}/files` and `compare` return it. */
export interface PrFileDiff {
  filename: string;
  status?: string | null;
  /** Unified diff; GitHub omits it for binary and very large files. */
  patch?: string | null;
  /** Blob sha at the head; the comparison when there is no patch. */
  sha?: string | null;
  previousFilename?: string | null;
}

export interface PrCommitFact {
  sha: string;
  message: string;
  /** Author date: survives a rebase, unlike the committer date. */
  authoredAt: Date | null;
}

export interface MergeReadinessOutcomeInput {
  pr: { merged: boolean; state: 'open' | 'closed' };
  decision: { headSha: string; decidedAt: Date };
  /** The PR head when it closed. */
  finalHeadSha: string;
  /** The PR's diff at the decision's head vs base. Null: the head is gone (force-pushed). */
  decisionDiff: PrFileDiff[] | null;
  /** The PR's diff at merge. */
  finalDiff: PrFileDiff[] | null;
  /** Files the base branch changed between the decision and the merge. */
  baseChangedFiles?: readonly string[];
  /** The PR's commits at merge, for the force-push fallback. */
  commits?: readonly PrCommitFact[] | null;
}

export type MergeReadinessOutcomeReason =
  | 'closed_unmerged'
  | 'head_unchanged'
  | 'diff_identical'
  | 'diff_changed'
  | 'force_pushed_no_new_commits'
  | 'force_pushed_refresh_only'
  | 'force_pushed_code_change';

export interface MergeReadinessOutcome {
  label: MergeReadinessOutcomeLabel;
  confidence: 'high' | 'low';
  reason: MergeReadinessOutcomeReason;
  /** Files that differ, for `code_change` from a diff. Sorted. */
  changedFiles?: string[];
}

const DRIZZLE_META_RE = /(^|\/)drizzle\/(.+\/)?meta\/(_journal\.json|[^/]*_snapshot\.json)$/;
const MIGRATION_SQL_RE = /(^|\/)drizzle\/(.+\/)?\d+_[^/]*\.sql$/;

export function isDrizzleMetaFile(path: string): boolean {
  return DRIZZLE_META_RE.test(path);
}

export function isMigrationSql(path: string): boolean {
  return MIGRATION_SQL_RE.test(path);
}

/** The changed lines of a patch, without hunk headers or context, so a refresh does not move them. */
export function normalizePatch(patch: string): string {
  return patch.split('\n')
    .filter(l => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'))
    .map(l => l.replace(/\s+$/, ''))
    .join('\n');
}

function fileFingerprint(f: PrFileDiff): string {
  if (f.patch) return `patch:${normalizePatch(f.patch)}`;
  return `blob:${f.status ?? ''}:${f.sha ?? ''}`;
}

/**
 * The diff as a comparable map: key → fingerprint. Migration SQL is keyed by
 * its directory and content (renumbering keeps it equal); drizzle meta files
 * and files the base also changed drop out.
 */
function comparableDiff(diff: readonly PrFileDiff[], baseChanged: ReadonlySet<string>): Map<string, { path: string; fp: string }> {
  const out = new Map<string, { path: string; fp: string }>();
  for (const f of diff) {
    if (isDrizzleMetaFile(f.filename)) continue;
    if (baseChanged.has(f.filename) || (f.previousFilename && baseChanged.has(f.previousFilename))) continue;
    const fp = fileFingerprint(f);
    const key = isMigrationSql(f.filename)
      ? `migration:${f.filename.replace(/[^/]*$/, '')}${fp}`
      : `file:${f.filename}`;
    out.set(key, { path: f.filename, fp });
  }
  return out;
}

/** Files that differ between two diffs after the exclusions above. Empty: the same change. */
export function diffChanges(decision: readonly PrFileDiff[], final: readonly PrFileDiff[], baseChangedFiles: readonly string[] = []): string[] {
  const baseChanged = new Set(baseChangedFiles);
  const a = comparableDiff(decision, baseChanged);
  const b = comparableDiff(final, baseChanged);
  const changed = new Set<string>();
  for (const [k, v] of a) if (b.get(k)?.fp !== v.fp) changed.add(v.path);
  for (const [k, v] of b) if (a.get(k)?.fp !== v.fp) changed.add(v.path);
  return [...changed].sort();
}

const REFRESH_MESSAGE_RES = [
  /^merge (remote-tracking )?branch\b/i,
  /^merge [0-9a-f]{7,40} into\b/i,
  /^merge (origin\/)?[\w./-]+ into\b/i,
  /^(chore|fix|build)(\([^)]*\))?!?:\s*(refresh|rebase|sync|update branch|merge)\b/i,
  /\brenumber(ed|s|ing)?\b.*\bmigrations?\b/i,
  /\bmigrations?\b.*\brenumber(ed|s|ing)?\b/i,
  /\bresolve[sd]? (merge )?conflicts?\b/i,
];

/** A commit message that only refreshes the branch: a base merge, a rebase, a migration renumber, a conflict fix. */
export function isRefreshCommitMessage(message: string): boolean {
  const subject = message.split('\n')[0]?.trim() ?? '';
  return REFRESH_MESSAGE_RES.some(re => re.test(subject));
}

/** The label for one decision head. Null: nothing to label yet (open PR, or no diff to read). */
export function labelMergeReadinessOutcome(input: MergeReadinessOutcomeInput): MergeReadinessOutcome | null {
  if (input.pr.state !== 'closed') return null;
  if (!input.pr.merged) return { label: 'close', confidence: 'high', reason: 'closed_unmerged' };
  if (input.finalHeadSha === input.decision.headSha) return { label: 'merge_now', confidence: 'high', reason: 'head_unchanged' };

  if (input.decisionDiff) {
    if (!input.finalDiff) return null;
    const changedFiles = diffChanges(input.decisionDiff, input.finalDiff, input.baseChangedFiles ?? []);
    return changedFiles.length === 0
      ? { label: 'merge_now', confidence: 'high', reason: 'diff_identical' }
      : { label: 'code_change', confidence: 'high', reason: 'diff_changed', changedFiles };
  }

  // Force-pushed: the decision's head cannot be diffed. Read what was
  // authored after the decision instead (author dates survive a rebase).
  if (!input.commits) return null;
  const decidedAt = input.decision.decidedAt.getTime();
  const after = input.commits.filter(c => c.authoredAt === null || c.authoredAt.getTime() > decidedAt);
  if (after.length === 0) return { label: 'merge_now', confidence: 'low', reason: 'force_pushed_no_new_commits' };
  if (after.every(c => isRefreshCommitMessage(c.message))) return { label: 'merge_now', confidence: 'low', reason: 'force_pushed_refresh_only' };
  return { label: 'code_change', confidence: 'low', reason: 'force_pushed_code_change' };
}

/**
 * The revert label for a merged decision. `reverted` once a revert of the PR
 * landed within the window; `not_reverted` once the window has passed without
 * one; null while it is still open.
 */
export function revertOutcome(input: { mergedAt: Date; revertedAt: Date | null; now: Date }): 'reverted' | 'not_reverted' | null {
  const deadline = input.mergedAt.getTime() + REVERT_WINDOW_MS;
  if (input.revertedAt && input.revertedAt.getTime() <= deadline) return 'reverted';
  if (input.now.getTime() > deadline) return 'not_reverted';
  return null;
}
