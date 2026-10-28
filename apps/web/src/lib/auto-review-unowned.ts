/**
 * Auto-review of a PR buildd did not open.
 *
 * A PR opened in a linked repo by anyone outside buildd (a person, or an agent
 * running `gh pr create`) has no kernel delivery and no review, so its required
 * `Buildd / Review approval` status reads "Review not requested" until somebody
 * calls `request_pr_review`. When the workspace opts in
 * (`gitConfig.mergePolicy.autoReviewUnowned`, `autoReviewUnownedEnabled`: on by
 * default under tier `agent-review`), the PR webhook asks for that review
 * itself, through the same request path (`requestPrReview`): the PR is adopted
 * as a task + worker, a reviewer is filed, and the verdict and the workspace's
 * merge policy apply as for a buildd PR. The status then reads "Review in
 * progress".
 *
 * Only a *foreign* PR is ever auto-reviewed: one buildd has no record of at all
 * (`isForeignPr`). A PR buildd knows (a kernel delivery, a worker row by PR
 * number or head branch, an adoption placeholder, a reviewer task, a
 * `buildd/<id8>-` task branch or a `mission/` branch) is not, even with no review
 * yet: buildd either reviews it on its own path or left it unreviewed on purpose.
 *
 * Never requested for: a draft, a bot's PR, a release candidate (or a PR whose
 * branches could make it one: those have their own gate), a known PR, or a PR
 * onto a base the repo's normal flow does not target (neither the default
 * branch nor a mission integration branch).
 *
 * A foreign PR this does not take (setting off, a draft, a bot's, another base)
 * carries no `Buildd / Review approval` at all (lib/workflow/open-pr-status.ts
 * reads `isForeignPr` too); one it takes is adopted, so it reads "Review in progress".
 *
 * Idempotent: the first request adopts the PR, so a duplicate or re-delivered
 * event finds it owned and requests nothing. A push to an adopted PR is the
 * existing re-review path's (`pr.synchronized`), which never forces a second
 * review of a head already judged. One reviewer per PR at a time is the request
 * path's own rule.
 *
 * Only the repo's primary linked workspace decides (the first by creation, the
 * one the open-PR status reads its review from), so a repo linked from several
 * workspaces is reviewed once.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { looksLikeMissionIntegrationBranch } from '@buildd/core/mission-integration';
import type { WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import { autoReviewUnownedEnabled } from '@buildd/shared';
import type { RequestPrReviewInput, RequestPrReviewResult, ReviewWorkspace } from '@/lib/request-pr-review';

/** The PR webhook actions that can make an unowned PR reviewable. */
const AUTO_REVIEW_ACTIONS = new Set(['opened', 'reopened', 'ready_for_review', 'synchronize']);

/** buildd's own request: a system actor, never a person (it may not force a re-review). */
const AUTO_REVIEW_ACTOR = 'system:webhook:auto-review';

export type AutoReviewOutcome =
  | 'requested'
  | 'already_requested'
  | 'refused'
  | 'skipped_action'
  | 'skipped_draft'
  | 'skipped_bot'
  | 'skipped_unlinked'
  | 'skipped_off'
  | 'skipped_candidate'
  | 'skipped_base'
  | 'skipped_known';

/** A linked workspace, with what deciding and requesting the review read. */
export interface AutoReviewWorkspace extends ReviewWorkspace {
  releaseConfig: WorkspaceReleaseConfig | null;
}

/** The PR as the webhook payload carries it (the fields read here and by the request path). */
export interface AutoReviewPr {
  number: number;
  draft?: boolean;
  state?: string;
  title?: string;
  body?: string | null;
  html_url: string;
  user?: { login?: string | null; type?: string | null } | null;
  head: { sha: string; ref?: string; repo?: { full_name?: string } | null };
  base?: { ref?: string; repo?: { full_name?: string } | null };
}

/** The ownership reads that say buildd knows a PR. */
export interface ForeignPrDeps {
  kernelOwned?: (workspaceId: string, repoFullName: string, prNumber: number) => Promise<boolean>;
  /** A worker row in one of these workspaces mapped to the PR number or to its head branch. */
  knownWorker?: (workspaceIds: string[], prNumber: number, headRef: string | null) => Promise<unknown | null>;
  reviewTask?: (workspaceId: string, prNumber: number) => Promise<unknown | null>;
}

export interface AutoReviewDeps extends ForeignPrDeps {
  /** The workspaces linking this repo, primary first (`linkedReposSql`'s order). */
  linkedWorkspaces?: (repoFullName: string) => Promise<AutoReviewWorkspace[]>;
  /** The release-candidate classifiers (`openPrReviewReads`, the releases module's). */
  reviews?: () => Promise<{
    isCandidate(releaseConfig: WorkspaceReleaseConfig | null, pr: Record<string, string | null | undefined>): boolean;
    mayBeCandidate(releaseConfig: WorkspaceReleaseConfig | null, refs: { headRef?: string | null; baseRef?: string | null }): boolean;
  }>;
  integrationBase?: (workspaceId: string, baseRef: string) => Promise<boolean>;
  request?: (input: RequestPrReviewInput) => Promise<RequestPrReviewResult>;
}

async function linkedWorkspacesLive(repoFullName: string): Promise<AutoReviewWorkspace[]> {
  const res = (await db.execute(sql`-- auto_review_unowned:linked_workspaces
SELECT w.id, w.team_id, w.name, w.repo, w.github_repo_id, w.github_installation_id, w.git_config, w.webhook_config, w.release_config
FROM workspaces w
JOIN github_repos gr ON gr.id = w.github_repo_id
JOIN github_installations gi ON gi.id = gr.installation_id
WHERE gi.suspended_at IS NULL AND lower(gr.full_name) = lower(${repoFullName})
ORDER BY gr.full_name, w.created_at, w.id`)) as unknown as { rows?: Array<Record<string, unknown>> };
  return (res.rows ?? []).map((r) => ({
    id: String(r.id), teamId: String(r.team_id), name: String(r.name), repo: (r.repo as string | null) ?? null,
    githubRepoId: (r.github_repo_id as string | null) ?? null, githubInstallationId: (r.github_installation_id as string | null) ?? null,
    gitConfig: (r.git_config as Record<string, unknown> | null) ?? null, webhookConfig: r.webhook_config ?? null,
    releaseConfig: (r.release_config as WorkspaceReleaseConfig | null) ?? null,
  }));
}

const foreignLiveDeps = (): Required<ForeignPrDeps> => ({
  kernelOwned: async (w, r, n) => !!(await (await import('@/lib/workflow/authority')).kernelDeliveryForPr(w, r, n)),
  knownWorker: async (ids, n, headRef) => (ids.length ? (await db.query.workers.findFirst({
    where: sqlWhere(and(inArray(workers.workspaceId, ids), headRef ? or(eq(workers.prNumber, n), eq(workers.branch, headRef)) : eq(workers.prNumber, n))),
    columns: { id: true },
  })) ?? null : null),
  reviewTask: async (w, n) => (await import('@/lib/pr-review-request')).findReviewTaskForPr(w, n),
});

/** buildd's own branch shapes: a task branch (`buildd/<id8>-`, the workspace's `branchPrefix`, `task-<id8>`) or a mission branch. */
export function isBuilddBranch(headRef: string | null | undefined, gitConfigs: ReadonlyArray<unknown> = []): boolean {
  if (!headRef) return false;
  if (looksLikeMissionIntegrationBranch(headRef)) return true;
  if (/^buildd\/[0-9a-f]{8}-/.test(headRef) || /^task-[0-9a-f]{8}$/.test(headRef)) return true;
  return gitConfigs.some((gc) => {
    const prefix = (gc as { branchPrefix?: unknown } | null)?.branchPrefix;
    return typeof prefix === 'string' && !!prefix && headRef.startsWith(prefix) && /^[0-9a-f]{8}-/.test(headRef.slice(prefix.length));
  });
}

/**
 * A PR buildd has no record of at all: no kernel delivery, no worker row by PR number or head branch
 * (an adopted PR has one), no reviewer task, and a head branch that is not one of buildd's own shapes.
 */
export async function isForeignPr(
  p: { workspaces: ReadonlyArray<{ id: string; gitConfig?: unknown }>; repoFullName: string; prNumber: number; headRef?: string | null },
  deps: ForeignPrDeps = {},
): Promise<boolean> {
  const d = { ...foreignLiveDeps(), ...deps };
  if (isBuilddBranch(p.headRef, p.workspaces.map((w) => w.gitConfig))) return false;
  const ids = p.workspaces.map((w) => w.id);
  if (await d.knownWorker(ids, p.prNumber, p.headRef ?? null)) return false;
  for (const id of ids) {
    if (await d.kernelOwned(id, p.repoFullName, p.prNumber)) return false;
    if (await d.reviewTask(id, p.prNumber)) return false;
  }
  return true;
}

const liveDeps = (): Required<AutoReviewDeps> => ({
  linkedWorkspaces: linkedWorkspacesLive,
  reviews: async () => (await import('@/modules')).openPrReviewReads(),
  ...foreignLiveDeps(),
  integrationBase: async (w, base) => !!(await (await import('@/lib/pr-review-request')).integrationMissionForBase(w, base)),
  request: async (input) => (await import('@/lib/request-pr-review')).requestPrReview(input),
});

function isBot(user: AutoReviewPr['user']): boolean {
  return !!user?.login?.toLowerCase().endsWith('[bot]') || user?.type === 'Bot';
}

/** Ask for buildd's review of a PR buildd did not open, when the workspace opts in (see the module doc). */
export async function maybeAutoReviewUnownedPr(
  input: { action: string; installationId: number; repoFullName: string; defaultBranch?: string | null; pr: AutoReviewPr },
  deps: AutoReviewDeps = {},
): Promise<AutoReviewOutcome> {
  const { action, installationId, repoFullName, pr } = input;
  if (!AUTO_REVIEW_ACTIONS.has(action)) return 'skipped_action';
  if (pr.draft) return 'skipped_draft';
  if (isBot(pr.user)) return 'skipped_bot';

  const d = { ...liveDeps(), ...deps };
  const links = await d.linkedWorkspaces(repoFullName);
  const primary = links[0];
  if (!primary) return 'skipped_unlinked';
  if (!autoReviewUnownedEnabled((primary.gitConfig as { mergePolicy?: unknown } | null)?.mergePolicy)) return 'skipped_off';

  // A release candidate has its own gate; a PR that could be one is never reviewed here.
  const reviews = await d.reviews();
  const facts = {
    headRef: pr.head.ref ?? null, baseRef: pr.base?.ref ?? null, headSha: pr.head.sha, author: pr.user?.login ?? null,
    headRepoFullName: pr.head.repo?.full_name ?? null, baseRepoFullName: pr.base?.repo?.full_name ?? repoFullName, body: pr.body ?? null,
  };
  if (links.some((l) => reviews.isCandidate(l.releaseConfig, facts) || reviews.mayBeCandidate(l.releaseConfig, facts))) return 'skipped_candidate';

  if (!(await isForeignPr({ workspaces: links, repoFullName, prNumber: pr.number, headRef: pr.head.ref ?? null }, d))) return 'skipped_known';

  const baseRef = pr.base?.ref ?? null;
  const defaultBranch = (primary.gitConfig as { defaultBranch?: unknown } | null)?.defaultBranch;
  const trunk = typeof defaultBranch === 'string' && defaultBranch ? defaultBranch : input.defaultBranch ?? null;
  if (!baseRef || (baseRef !== trunk && !(await d.integrationBase(primary.id, baseRef)))) return 'skipped_base';

  const out = await d.request({
    workspace: primary,
    repo: { fullName: repoFullName, installationId },
    pr: { state: 'open', ...pr },
    prNumber: pr.number,
    existingWorker: null,
    requester: {
      person: null,
      actor: AUTO_REVIEW_ACTOR,
      principal: { kind: 'system', id: AUTO_REVIEW_ACTOR },
      accountId: null,
      teamId: primary.teamId,
      creationSource: 'webhook',
      surface: 'webhook pull_request (auto-review)',
      origin: 'system',
    },
    force: false,
  });
  if (out.kind === 'response' || out.status >= 300) {
    const detail = out.kind === 'json' ? JSON.stringify(out.body).slice(0, 300) : `HTTP ${out.response.status}`;
    console.warn(`[auto-review] review of ${repoFullName}#${pr.number} not requested: ${detail}`);
    return 'refused';
  }
  return out.body.alreadyRequested ? 'already_requested' : 'requested';
}
