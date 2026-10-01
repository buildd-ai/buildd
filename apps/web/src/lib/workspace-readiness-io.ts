/**
 * IO shell for the workspace readiness report (docs/design/workspace-onboarding.md §2).
 *
 * Fetches the repo facts `computeReadiness` needs through the workspace's GitHub
 * installation and hands them to it. Read-only: GET requests to GitHub and one
 * read of the db, no writes anywhere. All detection lives in the pure core
 * function; this file only decides what to read, and stays inside fixed bounds.
 */

import { db } from '@buildd/core/db';
import { missions, type WorkspaceGitConfig, type WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { computeReadiness } from '@buildd/core/workspace-readiness';
import type { DeploymentSignal, ReadinessInput, ReadinessReport } from '@buildd/core/workspace-readiness';
import { detectSpecConformanceRoots } from '@buildd/core/spec-conformance-detect';
import type { WorkspaceReadinessReport } from '@buildd/shared';
import { githubApi } from '@/lib/github';

export const MAX_MANIFESTS = 12;
export const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_DEPLOYMENTS = 5;

const ROOT_MANIFESTS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Makefile'];
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const RELEASE_SHAPED = /release|deploy|publish/i;
const CI_SHAPED = /ci|test|build|check|lint/i;
const FORMAT_SHAPED = /format|readme|template|index/i;
const MAX_RELEASE_WORKFLOWS = 2;
const MAX_CI_WORKFLOWS = 3;
const MAX_SPECS = 2;

export interface TreeBlob {
  path: string;
  size?: number;
}

/**
 * Which files to read: a fixed, ordered allow-list, capped at MAX_MANIFESTS.
 * Root toolchain manifests first, then release-shaped and CI workflows (command
 * and release evidence), then a couple of existing specs (format evidence). A
 * blob over MAX_MANIFEST_BYTES is skipped without a fetch, so the item that
 * needs it reports `unknown` rather than guessing.
 */
export function selectManifestPaths(blobs: TreeBlob[], specsRoot: string | null): string[] {
  const readable = blobs.filter((b) => b.size === undefined || b.size <= MAX_MANIFEST_BYTES).map((b) => b.path);
  const has = new Set(readable);
  const workflows = readable.filter((p) => WORKFLOW.test(p));
  const name = (p: string) => p.split('/').pop() as string;

  const picked = [
    ...ROOT_MANIFESTS.filter((p) => has.has(p)),
    ...workflows.filter((p) => RELEASE_SHAPED.test(name(p))).slice(0, MAX_RELEASE_WORKFLOWS),
    ...workflows.filter((p) => !RELEASE_SHAPED.test(name(p)) && CI_SHAPED.test(name(p))).slice(0, MAX_CI_WORKFLOWS),
    ...(specsRoot
      ? readable
          .filter((p) => p.startsWith(`${specsRoot}/`) && p.toLowerCase().endsWith('.md') && !FORMAT_SHAPED.test(name(p)))
          .slice(0, MAX_SPECS)
      : []),
  ];
  return [...new Set(picked)].slice(0, MAX_MANIFESTS);
}

export interface ReadinessWorkspace {
  id: string;
  gitConfig: WorkspaceGitConfig | null;
  configStatus: 'unconfigured' | 'admin_confirmed';
  releaseConfig: WorkspaceReleaseConfig | null;
  githubRepo: { fullName: string; defaultBranch?: string | null; installation: { installationId: number } | null } | null;
}

/** A 409 from the git trees API is GitHub's answer for a repository with no commits. */
const isEmptyRepoError = (err: unknown) => err instanceof Error && /GitHub API error: 409\b/.test(err.message);

async function fetchTree(
  installationId: number,
  repo: string,
  branch: string,
): Promise<{ blobs: TreeBlob[]; truncated: boolean }> {
  try {
    const data = await githubApi(installationId, `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    const entries: Array<{ path: string; type: string; size?: number }> = Array.isArray(data?.tree) ? data.tree : [];
    return {
      blobs: entries.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, size: e.size })),
      truncated: data?.truncated === true,
    };
  } catch (err) {
    if (isEmptyRepoError(err)) return { blobs: [], truncated: false };
    throw err;
  }
}

async function fetchManifest(installationId: number, repo: string, path: string, ref: string): Promise<string | null> {
  try {
    const data = await githubApi(
      installationId,
      `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
    );
    if (data?.encoding !== 'base64' || typeof data.content !== 'string') return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/** `null` = deployments unavailable (no access); `[]` = none. */
async function fetchDeployments(installationId: number, repo: string): Promise<DeploymentSignal[] | null> {
  let list: Array<{ id: number; environment?: string }>;
  try {
    list = await githubApi(installationId, `/repos/${repo}/deployments?per_page=${MAX_DEPLOYMENTS}`);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const signals = await Promise.all(
    list.slice(0, MAX_DEPLOYMENTS).map(async (d): Promise<DeploymentSignal | null> => {
      try {
        const statuses = await githubApi(installationId, `/repos/${repo}/deployments/${d.id}/statuses?per_page=1`);
        const latest = Array.isArray(statuses) ? statuses[0] : null;
        if (!latest) return null;
        return { environment: d.environment ?? '', state: latest.state, environmentUrl: latest.environment_url ?? null };
      } catch {
        return null;
      }
    }),
  );
  return signals.filter((s): s is DeploymentSignal => s !== null);
}

async function fetchBranches(installationId: number, repo: string): Promise<string[] | undefined> {
  try {
    const data = await githubApi(installationId, `/repos/${repo}/branches?per_page=100`);
    return Array.isArray(data) ? data.map((b: { name: string }) => b.name) : undefined;
  } catch {
    return undefined;
  }
}

async function workspaceHasMissions(workspaceId: string): Promise<boolean> {
  const row = await db.query.missions.findFirst({ where: eq(missions.workspaceId, workspaceId), columns: { id: true } });
  return !!row;
}

/** Everything `computeReadiness` needs for one workspace. Throws only when the tree cannot be read. */
export async function gatherReadinessInput(workspace: ReadinessWorkspace): Promise<ReadinessInput> {
  const gitConfig = workspace.gitConfig;
  const base = {
    gitConfig,
    configStatus: workspace.configStatus,
    releaseConfig: workspace.releaseConfig,
  };
  const installation = workspace.githubRepo?.installation;
  if (!workspace.githubRepo || !installation) {
    return { ...base, files: null };
  }

  const { installationId } = installation;
  const repo = workspace.githubRepo.fullName;
  const branch = gitConfig?.defaultBranch || workspace.githubRepo.defaultBranch || 'main';

  const [{ blobs, truncated }, hasMissions] = await Promise.all([
    fetchTree(installationId, repo, branch),
    workspaceHasMissions(workspace.id),
  ]);
  const files = blobs.map((b) => b.path);
  const specsRoot = gitConfig?.specConformance?.specsRoot?.replace(/\/$/, '') ?? detectSpecConformanceRoots(files).specsRoot;

  const paths = selectManifestPaths(blobs, specsRoot);
  const [contents, deployments, branches] = await Promise.all([
    Promise.all(paths.map((p) => fetchManifest(installationId, repo, p, branch))),
    fetchDeployments(installationId, repo),
    fetchBranches(installationId, repo),
  ]);
  const manifests: Record<string, string> = {};
  paths.forEach((p, i) => {
    const text = contents[i];
    if (text !== null) manifests[p] = text;
  });

  return { ...base, files, truncated, manifests, deployments, branches, hasMissions };
}

export async function computeWorkspaceReadiness(workspace: ReadinessWorkspace): Promise<WorkspaceReadinessReport> {
  const report: ReadinessReport = computeReadiness(await gatherReadinessInput(workspace));
  // Compile-time check that core's report and the shared wire type stay one shape.
  return report satisfies WorkspaceReadinessReport;
}
