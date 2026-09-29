/**
 * Write the revert ledger (`pr_reverts`) from GitHub text: a merged PR's
 * title and body, or a commit message on a repo's default branch. The parse
 * is @buildd/core/pr-reverts; the reader is the candidate-memory promotion
 * query (@buildd/core/memory-lifecycle).
 *
 * Best-effort: the webhook never fails for it. Idempotent: a redelivery hits
 * the (workspace, dedupe key) unique index and inserts nothing.
 */
import { db } from '@buildd/core/db';
import { githubRepos, prReverts, workspaces } from '@buildd/core/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { parseRevertReferences, prRevertRows } from '@buildd/core/pr-reverts';

/** Rows written, across every workspace bound to the repo. */
export async function recordPrReverts(args: {
  /** "owner/name". */
  repoFullName: string;
  /** `pr#N` for a merged PR, the commit sha for a commit. */
  revertedBy: string;
  text: string | null | undefined;
  revertingPrNumber?: number;
}): Promise<number> {
  // Most text reverts nothing: skip the lookups entirely.
  const refs = parseRevertReferences(args.text, args.repoFullName);
  if (refs.prNumbers.length === 0 && refs.shas.length === 0) return 0;

  const repoRows = await db.select({ id: githubRepos.id }).from(githubRepos)
    .where(eq(githubRepos.fullName, args.repoFullName));
  if (repoRows.length === 0) return 0;
  const bound = await db.select({ id: workspaces.id }).from(workspaces)
    .where(inArray(workspaces.githubRepoId, repoRows.map(r => r.id)));

  const rows = bound.flatMap(ws => prRevertRows({
    workspaceId: ws.id,
    repo: args.repoFullName,
    revertedBy: args.revertedBy,
    text: args.text,
    revertingPrNumber: args.revertingPrNumber,
  }));
  if (rows.length === 0) return 0;
  const inserted = await db.insert(prReverts).values(rows).onConflictDoNothing().returning({ id: prReverts.id });
  return inserted.length;
}
