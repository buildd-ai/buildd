/**
 * Binds the release flow's reads and buttons to the real GitHub App, the
 * release dispatcher and the dashboard's gated merge route. The page and the
 * API route both go through here, so they see the same flow.
 */

import { NextRequest } from 'next/server';
import { githubApi } from '@/lib/github';
import { mergeReleasePrPinned } from './pinned-merge';
import { teamIdsWhere } from '@/lib/permissions';
import { fetchDeployedSha } from '@/lib/release-health-watcher';
import { loadReleaseFlow, type LoadFlowResult } from './compose-source';
import type { ComposeActionDeps } from './compose-actions';
import { dispatchWorkflowRelease } from './dispatch';
import { recordAndDispatchRelease } from './record';
import { resolveReleaseTarget, type ResolveTargetResult, type ReleaseTarget } from './target';

/** A workspace the person may run releases for (owner or admin of its team), or why not. */
export async function resolveComposeTarget(userId: string, workspaceId: string): Promise<ResolveTargetResult> {
  const teamIds = await teamIdsWhere({ kind: 'user', userId }, 'manage_releases');
  if (teamIds.length === 0) return { ok: false, status: 403, error: 'Only a team owner or admin can run a release.' };
  return resolveReleaseTarget({ workspaceId, scope: { teamIds } });
}

export function loadFlowFor(target: ReleaseTarget): Promise<LoadFlowResult> {
  return loadReleaseFlow(target, {
    github: (path) => githubApi(target.installationId, path),
    deployedSha: fetchDeployedSha,
  });
}

export function composeActionDeps(target: ReleaseTarget, origin: string): ComposeActionDeps {
  return {
    loadFlow: () => loadFlowFor(target),
    // The dashboard's own merge route, in-process and under the same session:
    // its worker lookup, mission-PR guard, landing policy and review gate all
    // apply. Including a mission never merges any other way.
    mergeThroughGate: async (prNumber, workspaceId) => {
      const { POST } = await import('@/app/api/prs/[prNumber]/merge/route');
      const res = await POST(
        new NextRequest(new URL(`/api/prs/${prNumber}/merge`, origin), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        }),
        { params: Promise.resolve({ prNumber: String(prNumber) }) },
      );
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    recordAndDispatch: (params) => recordAndDispatchRelease(params),
    dispatch: (installationId, owner, name, opts) => dispatchWorkflowRelease(installationId, owner, name, opts),
    // D10 (workflow-kernel-library.md §4): the candidate merges only at the SHA it was verified
    // on, through buildd's review gate (or the kernel's, for a PR it owns), not on GitHub's
    // reviews alone. A moved head is refused.
    mergePr: async (installationId, repo, prNumber, method, sha) => {
      const r = await mergeReleasePrPinned({
        workspaceId: target.workspaceId, installationId, repoFullName: repo, prNumber, verifiedHeadSha: sha, mergeMethod: method, surface: 'release compose',
      });
      // A lost answer stays pending (indeterminate), never reads as a refusal.
      return r.merged ? { merged: true, message: r.message } : { merged: false, message: r.message, ...(r.indeterminate ? { indeterminate: true } : {}) };
    },
    branchHead: async (branch) => {
      const ref = await githubApi(target.installationId, `/repos/${target.repoFullName}/git/ref/heads/${encodeURIComponent(branch)}`);
      return (ref?.object?.sha as string | undefined) ?? null;
    },
  };
}
