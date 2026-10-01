/**
 * The evidence read audit line (docs/specs/byo-evidence-storage.md, "Read
 * audit"): one structured `[evidence-read] {json}` log line per list or read.
 *
 * Its own module so the inline list that `get_task`, `get_pr` and `explain`
 * carry can audit without importing the S3 read path.
 */

export type EvidenceReadSurface =
  | 'GET /api/tasks/:id/evidence'
  | 'GET /api/evidence'
  | 'get_task'
  | 'get_pr'
  | 'explain';

export interface EvidenceActor { userId?: string | null; accountId?: string | null }

export interface EvidenceReadAudit {
  surface: EvidenceReadSurface;
  op: 'list' | 'read';
  workspaceId: string;
  taskId?: string | null;
  prNumber?: number | null;
  evidenceIds: string[];
  actor: EvidenceActor;
  query?: Record<string, string>;
  bytesReturned?: number;
  truncated?: boolean;
}

/**
 * Audit record for one evidence read. Written as one structured log line, the
 * same channel the `[lease-shadow]` and cron audit lines use, because there is
 * no read-audit table and the spec forbids inventing one here. Never throws.
 */
export function auditEvidenceRead(entry: EvidenceReadAudit): void {
  try {
    console.info(`[evidence-read] ${JSON.stringify({ ...entry, at: new Date().toISOString() })}`);
  } catch { /* an audit line never fails a read */ }
}
