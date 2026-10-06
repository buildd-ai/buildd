/** A PR opened outside create_pr still belongs to the worker holding its branch. */
export interface LocalPrRegistration {
  branch: string;
  repo: string;
  number: number;
  url: string;
  headSha: string;
  baseRef: string | null;
  draft: boolean;
}
export async function registerLocalPr(input: LocalPrRegistration,
  write: (input: LocalPrRegistration) => Promise<void> = persistLocalPr,
): Promise<void> {
  if (!input.branch || !input.repo || !input.number) return;
  await write(input);
}
async function persistLocalPr(input: LocalPrRegistration): Promise<void> {
  const [{ db }, { workers, workspaces }, { and, eq, inArray, isNull }, { workspaceRepoMatches }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'), import('./repo-scope'),
  ]);
  // Exact branch ownership AND repository scope, with a compare-and-set: never
  // overwrite an already registered PR, nor infer ownership from a task prefix.
  await db.update(workers).set({
    prUrl: input.url, prNumber: input.number, prBaseRef: input.baseRef,
    lastCommitSha: input.headSha, prIsDraft: input.draft,
    prLifecycleStatus: 'pr_open', prLastVerifiedAt: new Date(), updatedAt: new Date(),
  }).where(and(
    eq(workers.branch, input.branch), isNull(workers.prUrl),
    inArray(workers.workspaceId, db.select({ id: workspaces.id }).from(workspaces).where(workspaceRepoMatches(input.repo))),
  ));
}
