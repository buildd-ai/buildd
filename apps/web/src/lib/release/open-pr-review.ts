/**
 * The review half of `Buildd / Review approval` for an open PR the kernel does
 * not answer for (docs/specs/workflow-kernel-library.md §4, "Every open PR
 * carries it"): whether a review was asked for, and a frozen release
 * candidate's gate at its exact SHA. Read by the open-PR status sweep
 * (`apps/web/src/lib/workflow/open-pr-status.ts`) through the composition root
 * (`openPrReviewReads` in apps/web/src/modules.ts), since core never imports
 * the review modules.
 *
 * The candidate gate is the one the release doors merge under
 * (`pinned-merge.ts`): every required candidate check passed on the candidate
 * SHA, and buildd's review verdict gate does not hold that SHA. It uses the
 * pure `evaluateReviewVerdictGate`, not `guardReviewVerdict`, so an hourly read
 * records no gate event.
 */
import type { WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import { classifyReleasePr, type ReleasePrFacts } from '@buildd/core/release-candidate';
import { REQUIRED_CANDIDATE_CHECKS } from '@buildd/core/release-compose';
import { githubApi } from '@/lib/github';
import { listAllCheckRuns } from '@/lib/ci-verdict';
import { readPrReviewStatus } from '@/lib/pr-review-request';
import type { PrReviewStatus } from '@/lib/pr-review-status';
import { evaluateReviewVerdictGate } from '@/lib/review-verdict-gate';
import { toCandidateChecks, type CheckRunFact } from './compose-source';

// The shapes of packages/workflow-kernel/src/open-pr-status.ts, restated: outside the kernel only its
// entry points are imported (packages/core/__tests__/workflow-write-sites.test.ts, S14).
export type UnownedReview = 'not_requested' | 'in_progress';
export type CandidateCheckState = 'passing' | 'pending' | 'failing' | 'missing';
export interface CandidateGateInput {
  sha: string;
  checks: ReadonlyArray<{ name: string; state: CandidateCheckState }>;
  review: { verdict: 'pass' } | { verdict: 'pending' | 'changes_requested' | 'blocked'; reason?: string | null };
}

type Api = (installationId: number, path: string, options?: RequestInit) => Promise<unknown>;

export interface OpenPrReviewReads {
  /** Whether the PR is a frozen release candidate under this release config. */
  isCandidate(releaseConfig: WorkspaceReleaseConfig | null, pr: ReleasePrFacts): boolean;
  /** Whether a PR could be one, from its branches alone (no GitHub read). */
  mayBeCandidate(releaseConfig: WorkspaceReleaseConfig | null, refs: { headRef?: string | null; baseRef?: string | null }): boolean;
  /** A PR no delivery owns: was a buildd review asked for? */
  review(p: { workspaceId: string; prNumber: number }): Promise<UnownedReview>;
  /** A frozen release candidate: its required checks and review at `sha`. */
  candidate(p: { workspaceId: string; installationId: number; repoFullName: string; prNumber: number; sha: string }): Promise<Omit<CandidateGateInput, 'sha'>>;
}

export interface OpenPrReviewDeps {
  api?: Api;
  read?: (p: { workspaceId: string; prNumber: number }) => Promise<PrReviewStatus>;
}

/** The review state as the status reads it: anything past "nobody asked" is a review in progress until a delivery owns it. */
export function unownedReviewOf(state: PrReviewStatus['state']): UnownedReview {
  return state === 'not_requested' ? 'not_requested' : 'in_progress';
}

/** The review verdict gate's answer at the candidate SHA, as the candidate status reads it. */
export function candidateReviewOf(status: PrReviewStatus, sha: string): CandidateGateInput['review'] {
  const g = evaluateReviewVerdictGate(status, sha);
  if (!g.blocks) return { verdict: 'pass' };
  if (g.kind === 'changes_requested') return { verdict: 'changes_requested', reason: g.reason ?? null };
  if (g.kind === 'escalated') return { verdict: 'blocked', reason: g.reason ?? null };
  // A review still running, or an approval of an earlier SHA waiting for its re-review.
  return { verdict: 'pending', reason: null };
}

/**
 * Whether a PR could be a release candidate under `config`, from its branches alone (no GitHub read):
 * the workspace declares candidates, and, when the refs are known, the base is the prod branch and the
 * head matches a candidate branch. `classifyReleasePr` checks the shape first, so any rejection other
 * than `not_release_shape` (here the cross-repository one: no repos are given) means the shape fits.
 */
export function mayBeCandidate(config: WorkspaceReleaseConfig | null, refs: { headRef?: string | null; baseRef?: string | null }): boolean {
  if (!config?.candidate) return false;
  if (refs.headRef == null || refs.baseRef == null) return true;
  const c = classifyReleasePr(config, { headRef: refs.headRef, baseRef: refs.baseRef });
  return c.kind === 'candidate' || (c.kind === 'none' && c.reason !== 'not_release_shape');
}

export function openPrReviewReads(deps: OpenPrReviewDeps = {}): OpenPrReviewReads {
  const api = deps.api ?? (githubApi as Api);
  const read = deps.read ?? ((p) => readPrReviewStatus(p));
  return {
    isCandidate: (config, pr) => classifyReleasePr(config, pr).kind === 'candidate',
    mayBeCandidate,
    async review(p) {
      return unownedReviewOf((await read(p)).state);
    },
    async candidate(p) {
      const [runs, status] = await Promise.all([
        listAllCheckRuns<CheckRunFact>(api as never, p.installationId, p.repoFullName, p.sha),
        read({ workspaceId: p.workspaceId, prNumber: p.prNumber }),
      ]);
      const onSha = toCandidateChecks(runs.items, REQUIRED_CANDIDATE_CHECKS).filter((c) => c.sha === p.sha);
      const checks = REQUIRED_CANDIDATE_CHECKS.map((name): { name: string; state: CandidateCheckState } => {
        const c = onSha.find((x) => x.name === name);
        // A partial read of the runs is never evidence a check passed.
        return { name, state: c ? (c.state === 'passing' && !runs.complete ? 'pending' : c.state) : 'missing' };
      });
      return { checks, review: candidateReviewOf(status, p.sha) };
    },
  };
}
