/**
 * Who decides for a delivery (docs/specs/workflow-state-kernel.md §14).
 *
 * The kernel is ON for a workspace when `gitConfig.workflowKernel` is absent,
 * null, `true`, or the string `'true'` / `'on'`. Every other value turns it
 * OFF: `false`, `'false'`, `'off'`, and anything unrecognised (a typo, `0`,
 * `'no'`, `'disabled'`). An emergency switch fails toward legacy, the path
 * that needs no kernel at all. `kernelEnabled` (TypeScript) and
 * `kernelOnSql` (SQL) are the one reading; nothing else may parse the key.
 * A delivery belongs to exactly one authority:
 *
 *  - Deliveries exist only for PRs whose first review was dispatched after the
 *    kernel went live (seam.ts `openKernelDelivery`). A PR that was already
 *    open at cutover has no delivery row and finishes on the legacy paths, so
 *    no in-flight review loop is adopted half way through.
 *  - When the switch is off, the first touch of a kernel delivery releases it
 *    to legacy (`authority = 'legacy'`). The release is sticky: turning the
 *    switch back on does not hand it back, because legacy may have acted on it
 *    in between and the kernel's row would no longer describe it. The kernel
 *    projects into the legacy columns as it goes (reviewer tasks, fix tasks,
 *    `equivalentHeadShas`), so legacy can carry a released delivery on.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import type { Exec } from './kernel';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

export type Authority = 'kernel' | 'legacy';

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

const OFF = sql`NOT ${kernelOnSql(sql`w.git_config`)}`;

/**
 * One statement: find the delivery, release it to legacy if the switch is off,
 * and answer who decides. Zero rows = no delivery (legacy by definition).
 */
function resolveSql(where: SQL): SQL {
  return sql`-- workflow:resolve_authority
WITH d AS (
  SELECT d.id, d.authority, ${OFF} AS switched_off
  FROM workflow_deliveries d JOIN workspaces w ON w.id = d.workspace_id
  WHERE ${where}
  LIMIT 1
),
rel AS (
  UPDATE workflow_deliveries x SET authority = 'legacy', released_at = now(), updated_at = now()
  FROM d WHERE x.id = d.id AND x.authority = 'kernel' AND d.switched_off
  RETURNING x.id
)
SELECT d.id AS delivery_id,
  CASE WHEN d.authority = 'legacy' OR EXISTS (SELECT 1 FROM rel) THEN 'legacy' ELSE 'kernel' END AS authority,
  EXISTS (SELECT 1 FROM rel) AS released
FROM d`;
}

export function resolveByIdSql(deliveryId: string): SQL {
  return resolveSql(sql`d.id = ${deliveryId}::uuid`);
}

export function resolveByPrSql(workspaceId: string, repoFullName: string, prNumber: number): SQL {
  return resolveSql(sql`d.workspace_id = ${workspaceId}::uuid AND d.repo_full_name = ${repoFullName}::text AND d.pr_number = ${prNumber}::int`);
}

export function resolveByOwnerSql(workspaceId: string, ownerTaskId: string): SQL {
  return resolveSql(sql`d.workspace_id = ${workspaceId}::uuid AND d.owner_task_id = ${ownerTaskId}::uuid`);
}

export function releaseSql(deliveryId: string): SQL {
  return sql`-- workflow:release_to_legacy
UPDATE workflow_deliveries SET authority = 'legacy', released_at = now(), updated_at = now()
WHERE id = ${deliveryId}::uuid AND authority = 'kernel'
RETURNING id`;
}

export interface ResolvedAuthority {
  deliveryId: string;
  authority: Authority;
  released: boolean;
}

async function first(q: SQL, exec: Exec): Promise<ResolvedAuthority | null> {
  const row = ((await exec(q)).rows ?? [])[0] as { delivery_id: string; authority: string; released: boolean } | undefined;
  if (!row) return null;
  if (row.released) console.log(`[workflow] delivery ${row.delivery_id} released to legacy (workflowKernel kill switch)`);
  return { deliveryId: String(row.delivery_id), authority: row.authority === 'legacy' ? 'legacy' : 'kernel', released: !!row.released };
}

/** The kernel delivery that owns this PR, or null when legacy decides (no row, released, or switched off). */
export async function kernelDeliveryForPr(workspaceId: string, repoFullName: string, prNumber: number, exec: Exec = dbExec): Promise<string | null> {
  const r = await first(resolveByPrSql(workspaceId, repoFullName, prNumber), exec);
  return r?.authority === 'kernel' ? r.deliveryId : null;
}

/** As above, for an attempt task that carries `tasks.delivery_id`. */
export async function kernelDeliveryById(deliveryId: string, exec: Exec = dbExec): Promise<string | null> {
  const r = await first(resolveByIdSql(deliveryId), exec);
  return r?.authority === 'kernel' ? r.deliveryId : null;
}

export async function resolveOwnerDelivery(workspaceId: string, ownerTaskId: string, exec: Exec = dbExec): Promise<ResolvedAuthority | null> {
  return first(resolveByOwnerSql(workspaceId, ownerTaskId), exec);
}

/** Hand one delivery to legacy (a legacy-only decision, e.g. a pre-flight human escalation, took it). */
export async function releaseToLegacy(deliveryId: string, reason: string, exec: Exec = dbExec): Promise<void> {
  const rows = (await exec(releaseSql(deliveryId))).rows ?? [];
  if (rows.length) console.log(`[workflow] delivery ${deliveryId} released to legacy: ${reason}`);
}

/** Release the PR's kernel delivery, if any, to legacy. */
export async function releaseKernelDeliveryForPr(workspaceId: string, repoFullName: string, prNumber: number, reason: string, exec: Exec = dbExec): Promise<void> {
  try {
    const id = await kernelDeliveryForPr(workspaceId, repoFullName, prNumber, exec);
    if (id) await releaseToLegacy(id, reason, exec);
  } catch (err) {
    console.error(`[workflow] could not release ${repoFullName}#${prNumber} to legacy:`, err);
  }
}

// ── §14: the once-per-owner claim on the switch-off hand-off (seam.ts handOffToLegacy) ──

/** Claim the hand-off once per owner task (tasks.context.workflowLegacyHandoff). Zero rows = already handed off. */
export function claimLegacyHandoffSql(ownerTaskId: string, deliveryId: string): SQL {
  return sql`-- workflow:claim_legacy_handoff
UPDATE tasks SET context = COALESCE(context, '{}'::jsonb)
    || jsonb_build_object('workflowLegacyHandoff', jsonb_build_object('deliveryId', ${deliveryId}::text, 'at', now()))
WHERE id = ${ownerTaskId}::uuid AND NOT COALESCE(context ? 'workflowLegacyHandoff', false)
RETURNING id`;
}

export function unclaimLegacyHandoffSql(ownerTaskId: string): SQL {
  return sql`-- workflow:unclaim_legacy_handoff
UPDATE tasks SET context = context - 'workflowLegacyHandoff' WHERE id = ${ownerTaskId}::uuid RETURNING id`;
}
