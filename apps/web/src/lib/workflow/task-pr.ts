/**
 * A task's PR, derived on read (docs/specs/workflow-kernel-library.md §9, AC-1 slice 4 step 1).
 *
 * `tasks.result.prUrl` / `prNumber` used to be a snapshot the end of an attempt copied from its
 * worker row. A snapshot written at the end is exactly what a late or parked end overwrites on a
 * task that was requeued and claimed again, and it keeps every terminal statement writing
 * `result`. So no attempt writer stores them any more; every reader asks this module, which reads
 * where the PR actually lives, first match wins:
 *
 *  1. The task's own delivery (`tasks.delivery_id`, the task its owner): its bound PR, at the URL
 *     `create_pr` and the webhook record (`prRowOfDeliverySql`).
 *  2. The task's attempt worker rows (a claim made them), newest first, the first that carries a
 *     PR. Placeholder rows no runner executed (`NON_RUNNER_EXECUTOR_IDS`) are skipped here: the
 *     sibling row a second PR from one worker gets (worker-pr-slot.ts) is that PR's owner row, not
 *     the task's PR, so it must not displace the attempt's own first PR.
 *  3. A placeholder worker row, newest first: a task whose only row is one (an adopted PR, a PR a
 *     person attached with `correct_task_result`).
 *  4. The stored `result.prUrl` / `prNumber`: rows written before this slice, and the person act
 *     that attaches a PR to a task closed without a worker.
 *
 * The URL and the number always come from the same source. Read-only: one SELECT fragment, no
 * kernel command, so it is a kernel entry point like `delivery-view`.
 */
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { NON_RUNNER_EXECUTOR_IDS } from '@/lib/executor';
import type { Exec } from './kernel';

export interface TaskPr {
  prUrl: string | null;
  prNumber: number | null;
}

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

// Template-only SQL (no sql.raw / sql.join): many route tests mock drizzle's `sql` as a bare tag,
// and modules build these fragments at load (audit-fields.ts).
const PLACEHOLDER_RUNNERS = NON_RUNNER_EXECUTOR_IDS.join(',');
const placeholderSql = sql`(tpw.runner IS NOT NULL AND tpw.runner = ANY(string_to_array(${PLACEHOLDER_RUNNERS}::text, ',')))`;

/**
 * The task row a fragment reads, as its three columns. The default is the `tasks` columns, which a
 * relational query's `sqlWhere` / `sqlExtras` re-point at its alias. A single-table select renders
 * columns unqualified, where a bare `id` would bind to the subquery's own row: it passes
 * `TASKS_TABLE_REF` instead.
 */
export interface TaskRef { id: SQLWrapper; deliveryId: SQLWrapper; result: SQLWrapper }
/** Read when called, not at load: a test that mocks the schema need not carry `tasks`. */
const taskColumns = (): TaskRef => ({ id: tasks.id, deliveryId: tasks.deliveryId, result: tasks.result });
export const TASKS_TABLE_REF: TaskRef = { id: sql`"tasks"."id"`, deliveryId: sql`"tasks"."delivery_id"`, result: sql`"tasks"."result"` };
const T_ALIAS_REF: TaskRef = { id: sql`t.id`, deliveryId: sql`t.delivery_id`, result: sql`t.result` };

/** jsonb `{ prUrl, prNumber }` for the task row `t`, or SQL NULL when it has no PR anywhere. */
export function taskPrJsonSql(t: TaskRef = taskColumns()): SQL {
  const { id, deliveryId, result } = t;
  return sql`COALESCE(
    (SELECT jsonb_build_object('prUrl', 'https://github.com/' || tpd.repo_full_name || '/pull/' || tpd.pr_number::text, 'prNumber', tpd.pr_number)
       FROM workflow_deliveries tpd
      WHERE tpd.id = ${deliveryId} AND tpd.owner_task_id = ${id}
        AND tpd.pr_number IS NOT NULL AND tpd.repo_full_name IS NOT NULL),
    (SELECT jsonb_build_object('prUrl', tpw.pr_url, 'prNumber', tpw.pr_number)
       FROM workers tpw
      WHERE tpw.task_id = ${id} AND (tpw.pr_url IS NOT NULL OR tpw.pr_number IS NOT NULL)
      ORDER BY ${placeholderSql} ASC, tpw.created_at DESC, tpw.id DESC
      LIMIT 1),
    CASE WHEN jsonb_typeof(${result}) = 'object' AND (${result} ? 'prUrl' OR ${result} ? 'prNumber')
      THEN jsonb_build_object(
        'prUrl', CASE WHEN jsonb_typeof(${result}->'prUrl') = 'string' THEN ${result}->'prUrl' END,
        'prNumber', CASE WHEN ${result}->>'prNumber' ~ '^[0-9]+$' THEN to_jsonb((${result}->>'prNumber')::int) END)
    END
  )`;
}

/** The task's PR number (int) or NULL, for a SELECT list or a WHERE. */
export function taskPrNumberSql(t: TaskRef = taskColumns()): SQL<number | null> {
  return sql<number | null>`((${taskPrJsonSql(t)})->>'prNumber')::int`;
}

/** The task's PR URL (text) or NULL, for a SELECT list or a WHERE. */
export function taskPrUrlSql(t: TaskRef = taskColumns()): SQL<string | null> {
  return sql<string | null>`((${taskPrJsonSql(t)})->>'prUrl')`;
}

/** True when the task has a PR by the rule above. */
export function taskHasPrSql(t: TaskRef = taskColumns()): SQL<boolean> {
  return sql<boolean>`((${taskPrJsonSql(t)}) IS NOT NULL)`;
}

function toTaskPr(v: unknown): TaskPr {
  const o = (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown> | null;
  const n = o?.prNumber;
  const prNumber = typeof n === 'number' ? n : typeof n === 'string' && /^\d+$/.test(n) ? Number(n) : null;
  return { prUrl: typeof o?.prUrl === 'string' ? o.prUrl : null, prNumber };
}

/**
 * taskId → its PR, for every given task that has one. One statement. Never throws: a failed read
 * leaves the map empty and a caller shows what it stored (`withTaskPr` with no PR keeps it).
 */
export async function taskPrsFor(taskIds: readonly string[], exec: Exec = dbExec): Promise<Map<string, TaskPr>> {
  const out = new Map<string, TaskPr>();
  const ids = [...new Set(taskIds.filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    const res = await exec(sql`-- workflow:task_prs
      SELECT t.id::text AS id, ${taskPrJsonSql(T_ALIAS_REF)} AS pr
        FROM tasks t
       WHERE t.id IN (SELECT x::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) x)`);
    for (const row of (res.rows ?? []) as Array<{ id: string; pr: unknown }>) {
      if (row.pr == null) continue;
      const pr = toTaskPr(row.pr);
      if (pr.prUrl || pr.prNumber) out.set(row.id, pr);
    }
  } catch (err) {
    console.warn('[task-pr] PR read failed; surfaces show the stored result:', err instanceof Error ? err.message : err);
  }
  return out;
}

/** One task's PR, or null. */
export async function taskPrOf(taskId: string, exec: Exec = dbExec): Promise<TaskPr | null> {
  return (await taskPrsFor([taskId], exec)).get(taskId) ?? null;
}

/**
 * `result` with the derived PR laid over `prUrl` / `prNumber`, for a surface that hands the result
 * on (an API response, a page prop, a callback body). Never mutates. A task with no derived PR
 * keeps whatever it stored; a null result stays null unless there is a PR to show.
 */
export function withTaskPr<R extends Record<string, unknown> | null | undefined>(result: R, pr: TaskPr | null | undefined): R {
  if (!pr || (!pr.prUrl && pr.prNumber == null)) return result;
  return {
    ...((result ?? {}) as Record<string, unknown>),
    ...(pr.prUrl ? { prUrl: pr.prUrl } : {}),
    ...(pr.prNumber != null ? { prNumber: pr.prNumber } : {}),
  } as R;
}

/** Every row's `result` with its derived PR laid over it (one statement for the batch). */
export async function withTaskPrs<T extends { id: string; result?: unknown }>(rows: readonly T[], exec: Exec = dbExec): Promise<T[]> {
  if (rows.length === 0) return [...rows];
  const prs = await taskPrsFor(rows.map((r) => r.id), exec);
  if (prs.size === 0) return [...rows];
  return rows.map((r) => {
    const pr = prs.get(r.id);
    return pr ? { ...r, result: withTaskPr(r.result as Record<string, unknown> | null, pr) } : r;
  });
}
