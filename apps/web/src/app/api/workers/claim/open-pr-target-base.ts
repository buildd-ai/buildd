/**
 * Layer 1 of the claim route's path-overlap backstop judges an open PR by what
 * it would change on the branch the candidate lands on, not by everything its
 * task ever declared.
 *
 * The shape this closes: a trunk → mission-branch refresh PR. Its task starts
 * with an undeclared scope, the worker's merge touches every trunk file the
 * mission lacked, those touches are leased and promoted into the manifest when
 * the worker ends (working-set.ts `planPrHandoff`), and GitHub's own diff lists
 * the same files, because bringing them into the mission branch is what the PR
 * does. Narrowing to the PR diff (pr-scope-reconcile.ts) cannot shrink it. None
 * of it changes trunk, yet every trunk-bound task touching any of those files
 * was refused `path_overlap` until the refresh landed.
 *
 * The rule is the one layer 1 already applies after a merge: a PR merged into a
 * mission branch stops blocking trunk-bound work (mergedAt is set) although its
 * files reach trunk only with the mission. So while it is open, a PR into a
 * different landing base is not a layer-1 blocker either. Only when both bases
 * are known landing bases (trunk or a mission integration branch) and differ;
 * an unknown base, or a stacked phase branch, keeps today's answer. Migrations
 * on both sides stay blocking: an index collision across bases still surfaces
 * when the mission merges back.
 *
 * Live path leases (layer 2) and the soft-overlap gate are untouched.
 */
import { looksLikeMissionIntegrationBranch, resolveTaskPrBase, type MissionIntegrationFields, type TaskPrBaseTask } from '@buildd/core/mission-integration';
import { isMigrationPath } from '@buildd/core/path-overlap';

/** The base this candidate's PR will take, or null when that cannot be known. */
export function candidateLandingBase(input: {
  task: TaskPrBaseTask;
  mission: MissionIntegrationFields | null | undefined;
  trunk: string | null | undefined;
}): string | null {
  if (!input.trunk?.trim()) return null;
  return resolveTaskPrBase({ mission: input.mission, task: input.task, fallbacks: [input.trunk] }).base;
}

/** The workspace's trunk, as the claim route's gitConfig names it. */
export function workspaceTrunk(gitConfig: unknown): string | null {
  const g = (gitConfig && typeof gitConfig === 'object' ? gitConfig : {}) as { targetBranch?: unknown; defaultBranch?: unknown };
  const t = typeof g.targetBranch === 'string' && g.targetBranch.trim() ? g.targetBranch
    : typeof g.defaultBranch === 'string' && g.defaultBranch.trim() ? g.defaultBranch : null;
  return t ? t.trim() : null;
}

const isLandingBase = (ref: string, trunk: string) => ref === trunk || looksLikeMissionIntegrationBranch(ref);
const touchesMigration = (paths: string[] | null | undefined) => (paths ?? []).some(p => typeof p === 'string' && isMigrationPath(p));

/**
 * `sameBase`: PRs layer 1 still checks. `elsewhere`: PRs into a different
 * landing base, which do not block this candidate at layer 1.
 */
export function partitionOpenPrsByLandingBase<T extends { prBaseRef: string | null; pathManifest: string[] | null }>(
  candidate: { base: string | null; trunk: string | null; manifest: string[] | null },
  prs: T[],
): { sameBase: T[]; elsewhere: T[] } {
  const sameBase: T[] = [];
  const elsewhere: T[] = [];
  const { base, trunk } = candidate;
  const candidateMigrates = touchesMigration(candidate.manifest);
  for (const pr of prs) {
    const prBase = pr.prBaseRef?.trim() || null;
    const landsElsewhere = !!base && !!trunk && !!prBase && prBase !== base
      && isLandingBase(base, trunk) && isLandingBase(prBase, trunk)
      && !(candidateMigrates && touchesMigration(pr.pathManifest));
    (landsElsewhere ? elsewhere : sameBase).push(pr);
  }
  return { sameBase, elsewhere };
}
