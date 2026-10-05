/** Outcome labels use the same complete, revision-pinned read as claim reconciliation. */
import { eq } from 'drizzle-orm';
import { db } from './db/client';
import { workspaces, githubRepos, githubInstallations } from './db/schema';
import { getInstallationToken } from './github-installation-auth';
import { readPinnedPrScope, type PrScopeRead } from './pr-scope-read';

export interface TaskPrReference { taskId: string | null; prNumber: number | null; prUrl?: string | null }
export type TaskPrDiff = PrScopeRead & { prNumber: number };
export type TaskPrDiffMap = Map<string, TaskPrDiff[]>;
export type LoadTaskPrDiffs = (workspaceId: string, prs: readonly TaskPrReference[]) => Promise<TaskPrDiffMap>;

/** Missing auth/repository and failed/truncated reads remain explicit, never empty paths. */
export const loadTaskPrDiffs: LoadTaskPrDiffs = async (workspaceId, prs) => {
  const unique = new Map<string, TaskPrReference>();
  for (const pr of prs) if (pr.taskId && pr.prNumber) unique.set(`${pr.taskId}:${pr.prNumber}:${pr.prUrl ?? ''}`, pr);
  const result: TaskPrDiffMap = new Map();
  if (!unique.size) return result;
  let repo: string | null = null;
  let token: string | null = null;
  try {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    repo = workspace?.repo ?? null;
    if (workspace?.githubRepoId) {
      const linked = await db.query.githubRepos.findFirst({ where: eq(githubRepos.id, workspace.githubRepoId) });
      repo = linked?.fullName ?? repo;
    }
    if (workspace?.githubInstallationId) {
      const installation = await db.query.githubInstallations.findFirst({ where: eq(githubInstallations.id, workspace.githubInstallationId) });
      if (installation) token = await getInstallationToken(installation.installationId);
    }
  } catch { /* Each PR below records unavailable data. */ }
  const get = async (path: string) => {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub read failed (${response.status})`);
    return response.json();
  };
  const reads = new Map<string, Promise<PrScopeRead>>();
  const refs = [...unique.values()];
  // Bound GitHub pressure across the workspace's readout window.
  for (let offset = 0; offset < refs.length; offset += 4) {
    await Promise.all(refs.slice(offset, offset + 4).map(async pr => {
      const urlRepo = pr.prUrl?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+(?:[/?#]|$)/)?.[1];
      const repoFullName = urlRepo ?? repo;
      const key = `${repoFullName}:${pr.prNumber}`;
      if (!reads.has(key)) reads.set(key, !token || !repoFullName
        ? Promise.resolve({ status: 'incomplete', reason: 'read_failed', detail: 'GitHub installation or repository unavailable', headSha: null, baseSha: null })
        : readPinnedPrScope(get, { repoFullName, prNumber: pr.prNumber!, allowClosed: true }));
      const read = await reads.get(key)!;
      const existing = result.get(pr.taskId!) ?? [];
      existing.push({ ...read, prNumber: pr.prNumber! });
      result.set(pr.taskId!, existing);
    }));
  }
  return result;
};
