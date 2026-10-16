/**
 * The one reading of `gitConfig.workflowKernel` (docs/specs/workflow-state-kernel.md §14), in
 * TypeScript and in SQL. Pure: no I/O, no db. `authority.ts` re-exports it; see its header for
 * what the switch does to a delivery.
 */
import { sql, type SQL } from 'drizzle-orm';

/**
 * The values of `gitConfig.workflowKernel` that keep the kernel ON, as the
 * text `->>` yields for them (`true` and `'true'` both read `'true'`).
 * Absent and JSON null also mean on. Everything else is off.
 */
export const KERNEL_ON_TEXT = ['true', 'on'] as const;

/** Is the kernel on for a workspace with this gitConfig? The TypeScript half of the one reading. */
export function kernelEnabled(gitConfig: unknown): boolean {
  const cfg = gitConfig && typeof gitConfig === 'object' && !Array.isArray(gitConfig) ? (gitConfig as { workflowKernel?: unknown }) : null;
  const v = cfg?.workflowKernel;
  if (v === undefined || v === null || v === true) return true;
  return typeof v === 'string' && (KERNEL_ON_TEXT as readonly string[]).includes(v);
}

/**
 * The SQL half of the one reading: true when the kernel is on for the
 * workspace whose `git_config` column (or expression) is `gitConfig`. Matches
 * `kernelEnabled` value for value (tests/db/workflow-kill-switch-reading.test.ts).
 */
export function kernelOnSql(gitConfig: SQL): SQL {
  // `->>` on a NULL column, a non-object or an absent / JSON-null key is NULL: on.
  return sql`(COALESCE((${gitConfig})->>'workflowKernel', 'true') IN ('true', 'on'))`;
}

/** As `kernelOnSql`, for a workspace id: no workspace row reads as on (the delivery's own row decides). */
export function workspaceKernelOnSql(workspaceId: SQL): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM workspaces kw WHERE kw.id = ${workspaceId} AND NOT ${kernelOnSql(sql`kw.git_config`)})`;
}

