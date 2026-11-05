import { db } from '@buildd/core/db';
import { specs } from '@buildd/core/db/schema';
import { and, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';

/**
 * Proposals (Living Spec b7fc9316 R-35, AC-36; 65ed7fa3 R-81, AC-127).
 *
 * A proposal is a native draft nobody asked for: never approved, written by a
 * task's token (specs.created_by_task_id) where that task was not filed to
 * write specs (kind `writing`), pinned by no task and selected by no mission.
 * It is listed under Proposals on the specs page and is not an approval:
 * it stays out of the inbox, Home's count and `awaiting_approval`, until a
 * mission selects it or a task pins it, which returns it to the inbox.
 * A person's, an API key's or an import's draft has no writing task and is
 * never a proposal. Nothing here approves anything.
 */

/** A spec that is a proposal (SQL over `specs`). */
export const proposalWhere = () => sql`${specs.approvedRevision} IS NULL
  AND ${specs.createdByTaskId} IS NOT NULL
  AND coalesce(${specs.repoSource}->>'state', '') <> 'imported'
  AND NOT EXISTS (SELECT 1 FROM tasks wt WHERE wt.id = ${specs.createdByTaskId} AND wt.kind = 'writing')
  AND NOT EXISTS (SELECT 1 FROM tasks pt WHERE pt.workspace_id = ${specs.workspaceId}
    AND pt.context->'specSource'->>'specId' = ${specs.id}::text)
  AND NOT EXISTS (SELECT 1 FROM missions m WHERE m.workspace_id = ${specs.workspaceId}
    AND m.goal_criteria @> jsonb_build_array(jsonb_build_object('type', 'living_spec', 'specId', ${specs.id}::text)))`;

export interface ProposalRow {
  specId: string;
  title: string;
  workspaceId: string;
  headRevision: number;
  proposedAt: string;
  /** The task that wrote it, when it still exists. */
  taskId: string | null;
  taskTitle: string | null;
}

const rowsOf = <T,>(r: unknown) => ((r as { rows?: T[] }).rows ?? []);

/** A workspace's live proposals, newest first. Read access is the caller's to check. */
export async function listProposals(workspaceId: string): Promise<ProposalRow[]> {
  if (!isUuid(workspaceId)) return [];
  const rows = rowsOf<{ id: string; title: string; head_revision: number; created_at: string | Date; task_id: string | null; task_title: string | null }>(await db.execute(sql`
    SELECT specs.id, specs.title, specs.head_revision, specs.created_at, t.id AS task_id, t.title AS task_title
    FROM specs LEFT JOIN tasks t ON t.id = specs.created_by_task_id
    WHERE specs.workspace_id = ${workspaceId}::uuid
      AND specs.status NOT IN ('retired', 'superseded')
      AND ${proposalWhere()}
    ORDER BY specs.created_at DESC, specs.id`));
  return rows.map((r) => ({
    specId: r.id, title: r.title, workspaceId, headRevision: Number(r.head_revision),
    proposedAt: new Date(r.created_at).toISOString(), taskId: r.task_id, taskTitle: r.task_title,
  }));
}

/** Why an observation or scheduled task may not draft a spec, or null when it may. */
export async function draftRefusal(taskId: unknown): Promise<string | null> {
  if (typeof taskId !== 'string' || !isUuid(taskId)) return null;
  const rows = rowsOf<{ kind: string | null; schedule_id: string | null }>(await db.execute(sql`SELECT kind, schedule_id FROM tasks WHERE id = ${taskId}::uuid`));
  const t = rows[0];
  if (!t) return null;
  if (t.kind === 'observation') return 'A task of kind observation cannot create a spec: it reports what it saw, and a spec is a decision a person approves. Put the finding in an artifact or a note, or ask for a writing task to draft the spec. Nothing was written.';
  if (t.schedule_id) return 'A scheduled task cannot create a spec: nobody asked for it this run, and a spec waits on a person. Report in an artifact, or file a writing task if a spec is warranted. Nothing was written.';
  return null;
}
