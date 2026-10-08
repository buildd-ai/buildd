/**
 * Mission completion's input from the kernel (docs/specs/workflow-state-kernel.md
 * §17.3, Slice D): for every PR a mission reader judges, the kernel's delivery
 * when the kernel owns it. `canCompleteMission` and the `all_prs_merged`
 * criterion overlay it on the worker row (`withDeliveryShip`), so `prShipState`
 * answers from the delivery and the gate's own rules stay unchanged.
 *
 * Only kernel-owned deliveries are returned: a legacy PR (no delivery, released,
 * or its workspace switched the kernel off) is absent and keeps the column
 * answer. A read; it releases nothing.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import type { DeliveryShip } from '@buildd/core/pr-shipped';
import { repoFullNameFromPrUrl } from '@/lib/repo-scope';
import type { Exec } from './kernel';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

/**
 * `workspace:owner/repo#n` (repo lowercased): the delivery's natural key (§3).
 * The workspace is part of it: one repo can back several workspaces, each with
 * its own delivery for the same PR number.
 */
export function shipKey(workspaceId: string | null | undefined, prUrl: string | null | undefined): string | null {
  const repo = repoFullNameFromPrUrl(prUrl);
  const n = /\/pull\/(\d+)(?:[/?#]|$)/.exec(prUrl ?? '')?.[1];
  return workspaceId && repo && n ? `${workspaceId}:${repo.toLowerCase()}#${n}` : null;
}

export function deliveryShipSql(keys: string[]): SQL {
  return sql`-- workflow:delivery_ship
SELECT d.workspace_id || ':' || lower(d.repo_full_name) || '#' || d.pr_number AS ship_key, d.state, d.state_reason,
  d.superseded_by_pr, d.superseded_by_url, d.superseded_reason
FROM workflow_deliveries d JOIN workspaces w ON w.id = d.workspace_id
WHERE d.authority = 'kernel'
  AND COALESCE(w.git_config->>'workflowKernel', '') NOT IN ('false', 'off')
  AND d.pr_number IS NOT NULL
  AND d.workspace_id || ':' || lower(d.repo_full_name) || '#' || d.pr_number IN (SELECT jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb))`;
}

/**
 * shipKey → DeliveryShip for the kernel-owned PRs among `prs`. Never throws:
 * an unreadable kernel degrades to the column answer, which the kernel keeps
 * projected (§14 rollback), rather than failing a completion check.
 */
export async function deliveryShipsForPrs(
  prs: Array<{ workspaceId: string | null | undefined; prUrl: string | null | undefined }>,
  exec: Exec = dbExec,
): Promise<Map<string, DeliveryShip>> {
  const out = new Map<string, DeliveryShip>();
  const keys = [...new Set(prs.map((p) => shipKey(p.workspaceId, p.prUrl)).filter((k): k is string => !!k))];
  if (keys.length === 0) return out;
  try {
    for (const r of ((await exec(deliveryShipSql(keys))).rows ?? []) as Array<Record<string, unknown>>) {
      out.set(String(r.ship_key), {
        state: String(r.state),
        stateReason: r.state_reason == null ? null : String(r.state_reason),
        supersededByPr: r.superseded_by_pr == null ? null : Number(r.superseded_by_pr),
        supersededByUrl: r.superseded_by_url == null ? null : String(r.superseded_by_url),
        supersededReason: r.superseded_reason == null ? null : String(r.superseded_reason),
      });
    }
  } catch (err) {
    console.warn('[workflow] delivery ship states unavailable; mission readers fall back to the PR columns:', err instanceof Error ? err.message : err);
  }
  return out;
}
