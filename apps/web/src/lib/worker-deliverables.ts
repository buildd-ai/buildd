export interface DeliverableCheck {
  hasPR: boolean;
  hasArtifacts: boolean;
  hasStructuredOutput: boolean;
  hasCommits: boolean;
  /** True if any deliverable type is present */
  hasAny: boolean;
  /** Human-readable summary for audit trail / debugging */
  details: string;
}

/**
 * Check what deliverables a worker has produced.
 *
 * Pure function — single source of truth for "did this worker produce
 * meaningful output?" Used by the PATCH handler, cleanup cron, and stale
 * worker cleanup to make completion decisions across ALL output types
 * (PR, artifacts, structured output, commits).
 *
 * Callers must query artifact count themselves and pass it in.
 */
export function checkWorkerDeliverables(
  worker: {
    prUrl?: string | null;
    prNumber?: number | null;
    commitCount?: number | null;
  },
  opts?: {
    artifactCount?: number;
    taskResult?: { structuredOutput?: unknown } | null;
  },
): DeliverableCheck {
  const hasPR = !!worker.prUrl;
  const hasCommits = typeof worker.commitCount === 'number' && worker.commitCount > 0;

  // Check structured output — must be non-empty object
  const so = opts?.taskResult?.structuredOutput;
  const hasStructuredOutput = !!so && typeof so === 'object' && Object.keys(so as object).length > 0;

  const artifactCount = opts?.artifactCount ?? 0;
  const hasArtifacts = artifactCount > 0;

  const hasAny = hasPR || hasArtifacts || hasStructuredOutput || hasCommits;

  // Build human-readable details
  const parts: string[] = [];
  if (hasPR) parts.push(`PR #${worker.prNumber || '?'}`);
  if (hasArtifacts) parts.push(`${artifactCount} artifact${artifactCount !== 1 ? 's' : ''}`);
  if (hasStructuredOutput) parts.push('structured output');
  if (hasCommits) parts.push(`${worker.commitCount} commit${worker.commitCount !== 1 ? 's' : ''}`);

  return {
    hasPR,
    hasArtifacts,
    hasStructuredOutput,
    hasCommits,
    hasAny,
    details: parts.length > 0 ? parts.join(', ') : 'none',
  };
}

/**
 * Fetch the most recent artifact for a worker that has structuredOutput in its metadata.
 * Returns null when none exists or on DB error.
 */
export async function getLatestWorkerArtifactWithStructuredOutput(
  workerId: string,
): Promise<{ metadata: Record<string, unknown> } | null> {
  try {
    const { db } = await import('@buildd/core/db');
    const { artifacts } = await import('@buildd/core/db/schema');
    const { eq, desc } = await import('drizzle-orm');
    const rows = await db
      .select({ metadata: artifacts.metadata })
      .from(artifacts)
      .where(eq(artifacts.workerId, workerId))
      .orderBy(desc(artifacts.createdAt))
      .limit(10);
    const match = rows.find(r => {
      const meta = r.metadata as Record<string, unknown> | null | undefined;
      const so = meta?.structuredOutput;
      return so && typeof so === 'object' && 'summary' in (so as Record<string, unknown>);
    });
    if (!match) return null;
    return { metadata: (match.metadata as Record<string, unknown>) ?? {} };
  } catch {
    return null;
  }
}

/**
 * Query artifact count for a worker from the database.
 * Non-fatal — returns 0 on error.
 */
export async function getWorkerArtifactCount(workerId: string): Promise<number> {
  try {
    const { db } = await import('@buildd/core/db');
    const { artifacts } = await import('@buildd/core/db/schema');
    const { eq } = await import('drizzle-orm');
    const workerArtifacts = await db.query.artifacts.findMany({
      where: eq(artifacts.workerId, workerId),
      columns: { id: true },
    });
    return workerArtifacts.length;
  } catch {
    return 0;
  }
}
