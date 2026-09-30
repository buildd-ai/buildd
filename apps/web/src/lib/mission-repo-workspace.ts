/**
 * The one rule for "which workspace's repo does this mission's integration
 * branch live in". Its own module, with nothing but the DB, so the branch
 * ensurer and the mission-PR opener share it without either pulling in the
 * other's dependencies.
 */
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Which workspace's repo a mission's integration branch lives in.
 *
 * The mission's own `workspaceId` when it has one. A mission can be created
 * WITHOUT one (team-level, e.g. from an interactive session that passed no
 * workspace), and `resolveBranchStrategy(null)` still defaults it to
 * `mission-branch` — so the flag and a branch name get set while the one
 * function that cuts the branch looked only at `missions.workspaceId`, found
 * nothing, and returned `no_repo` on every call. Every task PR then fell back
 * to trunk, forever, while the prompt kept telling workers to target a branch
 * that was never created (mission 6341fe61 — see the PR that added this).
 *
 * The tasks themselves always carry a workspace, so fall back in order to the
 * caller's workspace (the task whose PR/claim is asking) and then to the one
 * workspace the mission's tasks share. More than one distinct workspace is
 * refused rather than guessed: an integration branch is one ref in one repo.
 */
export async function resolveMissionRepoWorkspaceId(args: {
  missionId: string;
  missionWorkspaceId?: string | null;
  hintWorkspaceId?: string | null;
}): Promise<{ workspaceId: string | null; detail?: string }> {
  if (args.missionWorkspaceId) return { workspaceId: args.missionWorkspaceId };
  if (args.hintWorkspaceId) return { workspaceId: args.hintWorkspaceId };
  const rows = ((await db.query.tasks.findMany({
    where: eq(tasks.missionId, args.missionId),
    columns: { workspaceId: true },
  })) ?? []) as Array<{ workspaceId: string | null }>;
  const distinct = [...new Set(rows.map(r => r.workspaceId).filter((w): w is string => !!w))];
  if (distinct.length === 1) return { workspaceId: distinct[0] };
  return {
    workspaceId: null,
    detail: distinct.length === 0
      ? 'mission has no workspace and none of its tasks name one'
      : `mission has no workspace and its tasks span ${distinct.length} workspaces`,
  };
}
