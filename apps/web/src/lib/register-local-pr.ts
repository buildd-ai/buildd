/** A PR opened outside create_pr still belongs to the worker holding its branch. */
export interface LocalPrRegistration {
  branch: string;
  repo: string;
  /** Source repository must match: branch names alone cannot identify fork ownership. */
  headRepo: string | null;
  number: number;
  url: string;
  headSha: string;
  baseRef: string | null;
  draft: boolean;
}
export async function registerLocalPr(input: LocalPrRegistration,
  write: (input: LocalPrRegistration) => Promise<void> = persistLocalPr,
): Promise<void> {
  if (!input.branch || !input.repo || !input.number ||
      input.headRepo?.toLowerCase() !== input.repo.toLowerCase()) return;
  await write(input);
}
async function persistLocalPr(input: LocalPrRegistration): Promise<void> {
  const [{ db }, { workers, workspaces }, { and, eq, inArray, isNull }, { workspaceRepoMatches }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'), import('./repo-scope'),
  ]);
  // Exact branch ownership AND repository scope, with a compare-and-set: never
  // overwrite an already registered PR, nor infer ownership from a task prefix.
  const bound = await db.update(workers).set({
    prUrl: input.url, prNumber: input.number, prBaseRef: input.baseRef,
    lastCommitSha: input.headSha, prIsDraft: input.draft,
    prLastVerifiedAt: new Date(), updatedAt: new Date(),
  }).where(and(
    eq(workers.branch, input.branch), isNull(workers.prUrl),
    inArray(workers.workspaceId, db.select({ id: workspaces.id }).from(workspaces).where(workspaceRepoMatches(input.repo))),
  )).returning({ id: workers.id });
  // The PR's state is a fact on the fact cache (recordPrFact), never a bare write.
  const { recordPrFact } = await import('@buildd/core/pr-facts');
  if (bound.length) await recordPrFact({ workerIds: bound.map((b) => b.id) }, { kind: 'open' });
}
