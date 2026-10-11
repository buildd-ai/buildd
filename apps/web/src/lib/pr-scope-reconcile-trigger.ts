/**
 * Schedule a PR-scope reconciliation (lib/pr-scope-reconcile.ts) without
 * making the caller wait for, or fail on, the GitHub reads it needs.
 *
 * Kept apart from the reconciler so hot routes (the webhook, worker PATCH) and
 * retry filers do not load it — or its ownership primitives — until it runs.
 * Runs after the response when there is a request scope, immediately (still
 * detached) when there is not. Never throws: skipping a reconciliation leaves
 * the conservative, wider scope in place.
 */
import { after } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { githubRepos, workspaces } from '@buildd/core/db/schema';

export interface PrScopeReconcileRequest {
  workspaceId: string;
  installationId: number;
  repoFullName: string;
  prNumber: number;
  /** The head the caller saw; a read at any other head changes nothing. */
  expectedHeadSha?: string | null;
}

export function schedulePrScopeReconcile(input: PrScopeReconcileRequest): void {
  const run = async () => {
    try {
      const { reconcilePrBackedScopeSafely } = await import('@/lib/pr-scope-reconcile');
      await reconcilePrBackedScopeSafely(input);
    } catch (err) {
      console.error(`[pr-scope] could not run reconciliation for PR #${input.prNumber}:`, err);
    }
  };
  try {
    after(run);
  } catch {
    void run();
  }
}

/**
 * Narrow a handed-off PR's scope once its worker has ended.
 *
 * `promoteLeasesToPrScope` (working-set.ts) widens the PR-owning task's
 * manifest to every path its worker leased, so layer 1 of the claim route still
 * sees the PR after the leases go. Its contract was that "the next push's
 * PR-scope reconciliation narrows it to the diff", and a PR with no later push
 * never got one: the inherited, worker-wide manifest blocked every overlapping
 * claim for as long as the PR stayed open. The reconciler refuses to narrow a
 * live PR owner, so the one moment it can act is right after the worker ends,
 * which is when this is called. One pinned read per worker end, never per claim
 * poll; the read records its head/base SHA on the task (PrScopeRecord) and the
 * webhook re-runs it on every later push.
 */
type RepoLink = { fullName: string; installationId: number };

async function linkedRepo(workspaceId: string): Promise<RepoLink | null> {
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { githubRepoId: true } });
  if (!ws?.githubRepoId) return null;
  const repo = await db.query.githubRepos.findFirst({ where: eq(githubRepos.id, ws.githubRepoId), with: { installation: true } }) as
    { fullName: string; installation: { installationId: number } | null } | undefined;
  return repo?.installation ? { fullName: repo.fullName, installationId: repo.installation.installationId } : null;
}

export async function scheduleHandoffScopeReconcile(
  input: { workspaceId: string; prNumber: number | null },
  deps: { resolveRepo?: (workspaceId: string) => Promise<RepoLink | null>; schedule?: (req: PrScopeReconcileRequest) => void } = {},
): Promise<void> {
  if (!input.prNumber) return;
  try {
    const repo = await (deps.resolveRepo ?? linkedRepo)(input.workspaceId);
    if (!repo) return;
    (deps.schedule ?? schedulePrScopeReconcile)({
      workspaceId: input.workspaceId, installationId: repo.installationId, repoFullName: repo.fullName, prNumber: input.prNumber,
    });
  } catch (err) {
    console.warn(`[pr-scope] could not schedule handoff reconciliation for PR #${input.prNumber}:`, err);
  }
}
