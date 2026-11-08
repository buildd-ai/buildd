/**
 * Adoption (never review) of a release-candidate PR the release workflow
 * opened directly on GitHub — `gh pr create` under the release bot's
 * identity (`buildd-release`), not buildd's own `create_pr`.
 *
 * No buildd task or worker ever held this branch: `release/vX.Y.Z` is cut by
 * the workflow from a captured `dev` SHA, not pushed by a worker's task
 * branch. So `registerLocalPr`'s branch-match (`register-local-pr.ts`) finds
 * nothing to bind the PR to, and `maybeAutoReviewUnownedPr` refuses it before
 * ever adopting anything — a release candidate is explicitly excluded there
 * (`skipped_bot`/`skipped_candidate`: "a release candidate has its own
 * gate"). With neither path ever writing a `workers` row, every surface
 * keyed on `workers.prNumber` (`pr-resolve.ts`, read by `get_pr`, `merge_pr`,
 * `list_prs`) answers "PR not found" for a PR that is open, green and
 * entirely legitimate — forcing a fallback to an authenticated `gh` merge
 * outside buildd's own tracking.
 *
 * This fills exactly that gap and nothing else: it binds a bookkeeping task +
 * worker to the PR (the same shape `resolveOrAdoptPrOwner` already gives a
 * foreign PR adopted by `request_pr_review`), so downstream reads resolve it.
 * It never requests a reviewer, never merges, and never changes who may merge
 * — the PUT /api/github/pr merge path and the candidate gate it already runs
 * (pinned SHA, required checks, review-verdict) are completely unmodified by
 * this; adoption only makes the PR findable.
 *
 * Trust is the full `classifyReleasePr` check (`kind === 'candidate'`) — the
 * same one the merge gate itself relies on (author in `candidate.authors`,
 * head in the base repo, the workflow's metadata present and matching this
 * exact branch/base/source, and the metadata's `candidateSha` pinned to the
 * PR's current head). A branch merely *shaped* like `release/vX.Y.Z` is never
 * enough — see `docs/specs/` release-candidate provenance rules
 * (packages/core/release-candidate.ts).
 */
import type { WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import { classifyReleasePr, type ReleasePrFacts } from '@buildd/core/release-candidate';
import { linkedWorkspacesLive, type AutoReviewPr, type AutoReviewWorkspace } from './auto-review-unowned';

/** The webhook actions that can make a brand-new release-candidate PR adoptable. Mirrors `registerLocalPr`'s own set. */
const ADOPT_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);

export type ReleaseCandidateAdoptOutcome =
  | 'adopted'
  | 'already_owned'
  | 'skipped_action'
  | 'skipped_unlinked'
  | 'skipped_not_candidate';

export interface ReleaseCandidateAdoptDeps {
  linkedWorkspaces?: (repoFullName: string) => Promise<AutoReviewWorkspace[]>;
  /** The full, trusted classification — never the shape-only `mayBeCandidate`. */
  classify?: (config: WorkspaceReleaseConfig | null, pr: ReleasePrFacts) => { kind: string };
  /** The id of the worker already owning this PR in this workspace, if any. */
  owningWorkerId?: (workspaceId: string, prNumber: number) => Promise<string | null>;
  adopt?: (p: { workspaceId: string; installationId: number; repoFullName: string; prNumber: number; pr: AutoReviewPr }) => Promise<unknown>;
}

const liveDeps = (): Required<ReleaseCandidateAdoptDeps> => ({
  linkedWorkspaces: linkedWorkspacesLive,
  classify: classifyReleasePr,
  owningWorkerId: async (workspaceId, prNumber) =>
    (await (await import('./pr-review-request')).findPrOwningWorker(workspaceId, prNumber))?.id ?? null,
  adopt: async (p) => (await import('./pr-review-request')).resolveOrAdoptPrOwner({
    workspaceId: p.workspaceId,
    installationId: p.installationId,
    repoFullName: p.repoFullName,
    prNumber: p.prNumber,
    pr: p.pr,
    creationSource: 'webhook',
  }),
});

/**
 * Adopt a release-candidate PR so it resolves like any other buildd-known PR.
 * Idempotent: a duplicate webhook delivery (or a later lifecycle event on the
 * same PR) finds the worker already bound and adopts nothing a second time.
 */
export async function maybeAdoptReleaseCandidatePr(
  input: { action: string; installationId: number; repoFullName: string; pr: AutoReviewPr },
  deps: ReleaseCandidateAdoptDeps = {},
): Promise<ReleaseCandidateAdoptOutcome> {
  const { action, installationId, repoFullName, pr } = input;
  if (!ADOPT_ACTIONS.has(action)) return 'skipped_action';

  const d = { ...liveDeps(), ...deps };

  const links = await d.linkedWorkspaces(repoFullName);
  if (links.length === 0) return 'skipped_unlinked';

  const facts: ReleasePrFacts = {
    headRef: pr.head.ref ?? null,
    baseRef: pr.base?.ref ?? null,
    headSha: pr.head.sha,
    author: pr.user?.login ?? null,
    headRepoFullName: pr.head.repo?.full_name ?? null,
    baseRepoFullName: pr.base?.repo?.full_name ?? repoFullName,
    body: pr.body ?? null,
  };
  const candidateLink = links.find((l) => d.classify(l.releaseConfig, facts).kind === 'candidate');
  if (!candidateLink) return 'skipped_not_candidate';

  if (await d.owningWorkerId(candidateLink.id, pr.number)) return 'already_owned';

  await d.adopt({ workspaceId: candidateLink.id, installationId, repoFullName, prNumber: pr.number, pr });
  return 'adopted';
}
