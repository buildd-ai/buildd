/**
 * A red frozen release candidate (release/vX.Y.Z into prodBranch, cut by the
 * repo's release workflow from one source SHA) is never repaired on its branch.
 *
 * Any push the workflow did not make moves the head off the candidate SHA its
 * metadata records, so the candidate stops being one: the workflow's identify
 * step refuses it and every check and approval must be redone. The fix lands on
 * the branch the candidate was cut from (`releaseConfig.candidate.sourceBranch`,
 * e.g. dev) as an ordinary PR, and once it merges the candidate is amended (automatically, see lib/release/candidate-amend.ts)
 * through the Release workflow (`amend` input), which re-cuts it from the new
 * source SHA. See docs/specs/release-flow.md.
 *
 * Pure: classification and the fix task's fields. The CI doors
 * (`retryCiFailureForPr`, the manual retry-ci route) do the I/O.
 */
import type { WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import {
  classifyReleasePr,
  hasReleasePrShape,
  isLegacyReleasePr,
  type ReleasePrFacts,
  type ReleasePrRejection,
} from '@buildd/core/release-candidate';

export type CiRedReleaseClass =
  | { kind: 'ordinary' }
  /** A trusted candidate at its recorded head: file the fix on `sourceBranch`. */
  | { kind: 'candidate'; version: string; headRef: string; sourceBranch: string }
  /**
   * Candidate-shaped (a candidate branch into prodBranch) but not provably one:
   * its head moved, or its author or metadata is not the workflow's. Pushing to
   * it is still wrong, and nothing is filed; the candidate needs an amendment.
   */
  | { kind: 'candidate_shaped'; reason: ReleasePrRejection };

/** Context key on the fix task: the candidate it was filed for. */
export const RELEASE_CANDIDATE_FIX_KEY = 'releaseCandidateFix';
/** Owner task context key: the candidate head a fix was already filed for (once per head). */
export const RELEASE_CANDIDATE_FIX_HEAD_KEY = 'releaseCandidateFixHeadSha';

export function classifyCiRedReleasePr(
  config: WorkspaceReleaseConfig | null | undefined,
  pr: ReleasePrFacts,
): CiRedReleaseClass {
  const refs = { headRef: pr.headRef, baseRef: pr.baseRef };
  // The legacy dev -> main PR moves with dev; its CI fixes go to dev already.
  if (isLegacyReleasePr(config, refs) || !hasReleasePrShape(config, refs)) return { kind: 'ordinary' };
  const cls = classifyReleasePr(config, pr);
  if (cls.kind === 'candidate') {
    return { kind: 'candidate', version: cls.version, headRef: cls.headRef, sourceBranch: cls.sourceBranch };
  }
  return { kind: 'candidate_shaped', reason: cls.kind === 'none' ? cls.reason : 'not_release_shape' };
}

export function releaseCandidateBranchPushRefusal(prNumber: number, sourceBranch: string | null): string {
  const source = sourceBranch ? `\`${sourceBranch}\`` : 'the branch it was cut from';
  return `PR #${prNumber} is a frozen release candidate: a fix is never pushed to its branch. ` +
    `Fix it on ${source}, then amend the candidate through the Release workflow (amend input).`;
}

/**
 * Refs only: is this PR shaped like a frozen candidate (a candidate branch into
 * prodBranch, trusted or not)? The conflict and refresh doors refuse any such
 * PR. Shape is enough here because refusing is the safe direction: a merge of
 * the base into a candidate un-candidates it just as a CI fix push would.
 */
export function isCandidateShapedReleasePr(
  config: WorkspaceReleaseConfig | null | undefined,
  refs: { headRef?: string | null; baseRef?: string | null },
): boolean {
  return !isLegacyReleasePr(config, refs) && hasReleasePrShape(config, refs);
}

export function releaseCandidateConflictRefusal(prNumber: number, sourceBranch: string | null): string {
  const source = sourceBranch ? `\`${sourceBranch}\`` : 'the branch it was cut from';
  return `PR #${prNumber} is a frozen release candidate: no conflict fix or refresh is ever pushed to its branch. ` +
    `Bring ${source} up to date with the prod branch, then amend the candidate through the Release workflow (amend input).`;
}

export interface ReleaseCandidateFixParams {
  workspaceId: string;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  version: string;
  headRef: string;
  sourceBranch: string;
  failureContext: string;
  ciRunUrl?: string | null;
  ciFailedJobId?: number | null;
}

/**
 * The fix task for a red candidate: an ordinary builder task based on the
 * source branch. It carries no PR binding (no ciRetryPrNumber, parent, resume
 * branch or repair target), so nothing routes its push to the candidate branch.
 */
export function buildReleaseCandidateFixTask(p: ReleaseCandidateFixParams) {
  const v = `v${p.version}`;
  const logCommand = p.ciFailedJobId
    ? `gh api /repos/${p.repoFullName}/actions/jobs/${p.ciFailedJobId}/logs | sed 's/^[0-9T:.-]*Z //' | tail -200`
    : null;
  const description = `CI failed on release candidate ${v} (PR #${p.prNumber}, \`${p.headRef}\` at ${p.headSha.slice(0, 12)}) in ${p.repoFullName}.

A candidate is frozen: it is cut from one \`${p.sourceBranch}\` commit, and a push to its branch makes it stop being a candidate. **Do not push to \`${p.headRef}\`** and do not open or update a PR from it.

## What failed

\`\`\`
${p.failureContext}
\`\`\`
${logCommand ? `\nRead the failing job's log:\n\n\`\`\`bash\n${logCommand}\n\`\`\`\n` : ''}${p.ciRunUrl ? `\nRun: ${p.ciRunUrl}\n` : ''}
## Instructions

1. Work on a branch from the latest \`${p.sourceBranch}\`. The failure was introduced by commits that are on \`${p.sourceBranch}\` too, so reproduce it there first.
2. Fix the cause (code or test), run the failing tests locally.
3. Open a PR into \`${p.sourceBranch}\` with \`create_pr\` (base \`${p.sourceBranch}\`).
4. In the PR body and your completion summary, say that release candidate ${v} (PR #${p.prNumber}) needs an amendment or a re-cut once this merges. Do not dispatch a release yourself: when this PR merges, buildd amends the candidate through the release workflow if the workspace declared how, and otherwise tells the team the candidate needs a re-cut.

This task cannot complete without a PR. "Dev already has the fix" is a claim to verify, not a verdict: reproduce the failing suites on the latest \`${p.sourceBranch}\` (including the real-Postgres DB architecture suite when a migration or snapshot is involved). If it really is fixed there, complete with \`alreadyShippedIn\` set to what carries the fix: a merged PR, or the \`${p.sourceBranch}\` commit (its SHA) when it was pushed without one. buildd checks that the commit is on \`${p.sourceBranch}\` and not already in the candidate, then amends the candidate, exactly as when a fix PR merges. A completion that names neither never amends it.
`;
  return {
    workspaceId: p.workspaceId,
    title: `fix(release): CI is red on release candidate ${v}, fix it on ${p.sourceBranch}`,
    description,
    creationSource: 'webhook' as const,
    kind: 'engineering' as const,
    roleSlug: 'builder',
    // A fix that ends without a PR never triggers the amend (lib/release/candidate-amend.ts),
    // so completion needs a PR, or `alreadyShippedIn` naming a merged one. A red candidate
    // caps a release: it routes to a tier that can diagnose, not the cheapest.
    outputRequirement: 'pr_required' as const,
    tier: 'premium' as const,
    context: {
      baseBranch: p.sourceBranch,
      [RELEASE_CANDIDATE_FIX_KEY]: { prNumber: p.prNumber, headSha: p.headSha, version: p.version, branch: p.headRef, sourceBranch: p.sourceBranch },
    } as Record<string, unknown> & { baseBranch: string },
  };
}
