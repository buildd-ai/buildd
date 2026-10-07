import { and, eq, sql } from 'drizzle-orm';
import { workers } from '@buildd/core/db/schema';

/**
 * The workers of ONE repo's PR. PR numbers are per repo, so a workspace with
 * several repos can hold two workers with the same `prNumber`; the worker row
 * carries no repo column, only the PR url, which names it.
 */
export function prWorkerWhere(workspaceId: string, repoFullName: string, prNumber: number) {
  const escaped = repoFullName.replace(/[\\%_]/g, (c) => `\\${c}`);
  return and(
    eq(workers.workspaceId, workspaceId),
    eq(workers.prNumber, prNumber),
    sql`${workers.prUrl} LIKE ${`%/${escaped}/pull/${prNumber}`} ESCAPE '\\'`,
  );
}
