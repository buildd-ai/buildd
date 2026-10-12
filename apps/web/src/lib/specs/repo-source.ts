/**
 * Reads a repo file at an exact commit for a Living Spec reference, through the
 * workspace's GitHub App installation. The repo is the one the workspace's
 * `github_repos` link names, never the free-text `workspaces.repo` column: a
 * reference is only as trustworthy as the repo identity it was checked against.
 *
 * The commit is checked as a commit first (`git/commits/<sha>` accepts nothing
 * but a SHA), then the file is read with `ref=<sha>`, so a branch that happens
 * to look like a SHA can never stand in for one.
 */
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { WORKSPACE_INSTALLATION_WITH, pickWorkspaceRepoIdentity } from '@/lib/workspace-installation';
import { sqlWhere } from '@buildd/core/db/relational-sql';

/** A cited file larger than this is refused rather than read in full. */
export const MAX_REPO_REF_FILE_BYTES = 1_000_000;

export type RepoFileResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'no_repo' | 'not_found' | 'not_a_file' | 'too_large' | 'unavailable'; message: string };

type Api = (installationId: number, path: string) => Promise<any>;

const statusOf = (err: unknown) => Number(/GitHub API error: (\d{3})\b/.exec(err instanceof Error ? err.message : '')?.[1] ?? 0);

/** One file at one commit, given the repo and installation. Exported for unit tests. */
export async function fetchFileAtCommit(
  repo: { fullName: string; installationId: number },
  path: string,
  commitSha: string,
  api: Api = githubApi,
): Promise<RepoFileResult> {
  try {
    await api(repo.installationId, `/repos/${repo.fullName}/git/commits/${commitSha}`);
  } catch (err) {
    const s = statusOf(err);
    if (s === 404 || s === 422) return { ok: false, reason: 'not_found', message: `commit ${commitSha} is not in ${repo.fullName}` };
    return { ok: false, reason: 'unavailable', message: `GitHub could not be reached to check commit ${commitSha.slice(0, 12)}` };
  }
  let data: any;
  try {
    data = await api(repo.installationId, `/repos/${repo.fullName}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${commitSha}`);
  } catch (err) {
    const s = statusOf(err);
    if (s === 404 || s === 422) return { ok: false, reason: 'not_found', message: `${path} does not exist at ${commitSha.slice(0, 12)}` };
    return { ok: false, reason: 'unavailable', message: `GitHub could not be reached to read ${path}` };
  }
  if (Array.isArray(data) || data?.type !== 'file') return { ok: false, reason: 'not_a_file', message: `${path} is not a file at ${commitSha.slice(0, 12)}` };
  if (typeof data.size === 'number' && data.size > MAX_REPO_REF_FILE_BYTES) return { ok: false, reason: 'too_large', message: `${path} is larger than ${MAX_REPO_REF_FILE_BYTES} bytes` };
  if (data.encoding !== 'base64' || typeof data.content !== 'string') return { ok: false, reason: 'too_large', message: `${path} is too large to read through the contents API` };
  return { ok: true, text: Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8') };
}

/** The workspace's linked repo, or null when it has none (or no installation). */
export async function linkedRepo(workspaceId: string): Promise<{ fullName: string; installationId: number } | null> {
  const ws = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, workspaceId)), with: WORKSPACE_INSTALLATION_WITH });
  const id = pickWorkspaceRepoIdentity(ws);
  if (id.source !== 'github_repo' || !id.fullName || !id.installationId) return null;
  return { fullName: id.fullName, installationId: id.installationId };
}

/** The `owner/name` of the workspace's linked repo, for links to a cited file; null without one. */
export async function linkedRepoFullName(workspaceId: string): Promise<string | null> {
  return (await linkedRepo(workspaceId))?.fullName ?? null;
}

export async function readRepoFileAtCommit(workspaceId: string, path: string, commitSha: string): Promise<RepoFileResult> {
  const repo = await linkedRepo(workspaceId);
  if (!repo) return { ok: false, reason: 'no_repo', message: 'this workspace has no GitHub repo linked through the GitHub App' };
  return fetchFileAtCommit(repo, path, commitSha);
}
