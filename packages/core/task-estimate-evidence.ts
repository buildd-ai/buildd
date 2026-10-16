/** Frozen workspace history accounting, shared by selection and diagnostics.
 * Exclusions are mutually exclusive. No semantic kind, role, model or age filter.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { TaskEstimateEvidence } from '@buildd/shared';

function historyRows(workspaceId: string, cutoff: Date): SQL {
  const at = cutoff.toISOString();
  return sql`
    SELECT t.id,
           (t.task_class = 'work' AND t.status = 'completed') AS completed_work,
           CASE
             WHEN t.task_class <> 'work' OR t.status <> 'completed' THEN 'not_completed_work'
             WHEN EXISTS (
               SELECT 1 FROM workers w WHERE w.task_id = t.id
                 AND w.completed_at >= ${at}::timestamptz
             ) THEN 'outcome_after_cutoff'
             WHEN s.minutes IS NULL OR s.minutes <= 0 THEN 'missing_session_actuals'
             WHEN s.tokens IS NULL OR s.tokens <= 0 THEN 'invalid_tokens'
             ELSE NULL
           END AS exclusion
      FROM tasks t
      LEFT JOIN LATERAL (
        SELECT SUM(EXTRACT(EPOCH FROM (w.completed_at - w.started_at)) / 60.0) AS minutes,
               SUM(COALESCE(w.input_tokens, 0) + COALESCE(w.output_tokens, 0)) AS tokens
          FROM workers w
         WHERE w.task_id = t.id AND w.workspace_id = t.workspace_id
           AND w.status = 'completed'
           AND w.started_at IS NOT NULL AND w.completed_at > w.started_at
           AND w.completed_at < ${at}::timestamptz
      ) s ON true
     WHERE t.workspace_id = ${workspaceId} AND t.created_at < ${at}::timestamptz
  `;
}

export function eligibleEstimateTasksQuery(workspaceId: string, cutoff: Date): SQL {
  return sql`SELECT id FROM (${historyRows(workspaceId, cutoff)}) history WHERE exclusion IS NULL`;
}

export function historyEvidenceQuery(workspaceId: string, cutoff: Date): SQL {
  return sql`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE completed_work) AS completed_work,
           COUNT(*) FILTER (WHERE exclusion IS NULL) AS eligible,
           COUNT(*) FILTER (WHERE exclusion = 'not_completed_work') AS not_completed_work,
           COUNT(*) FILTER (WHERE exclusion = 'outcome_after_cutoff') AS outcome_after_cutoff,
           COUNT(*) FILTER (WHERE exclusion = 'missing_session_actuals') AS missing_session_actuals,
           COUNT(*) FILTER (WHERE exclusion = 'invalid_tokens') AS invalid_tokens
      FROM (${historyRows(workspaceId, cutoff)}) history
  `;
}

export function historyEvidenceFrom(rows: ReadonlyArray<Record<string, unknown>>): TaskEstimateEvidence['history'] {
  const row = rows[0];
  if (!row) return null;
  const count = (key: string): number | null => {
    const raw = row[key];
    if (raw === undefined) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  };
  const total = count('total'), completedWork = count('completed_work'), eligible = count('eligible');
  if (total === null || completedWork === null || eligible === null) return null;
  const excluded: Record<string, number> = {};
  for (const key of ['not_completed_work', 'outcome_after_cutoff', 'missing_session_actuals', 'invalid_tokens']) {
    const n = count(key);
    if (n) excluded[key] = n;
  }
  return { total, completedWork, eligible, excluded };
}
