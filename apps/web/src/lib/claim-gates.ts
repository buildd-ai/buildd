/**
 * Claim-gate predicates for /api/tasks/[id]/start.
 *
 * These mirror the guards enforced by /api/workers/claim/route.ts so that /start
 * can surface a useful 422 before broadcasting TASK_ASSIGNED to workers that
 * will immediately reject the claim. The implementations are intentionally kept
 * in sync by code review rather than shared at runtime — claim/route.ts uses
 * SQL subquery conditions for bulk filtering whereas /start queries a single task
 * in isolation. If you change the claim-route gates, update these helpers too.
 *
 * Drift risk: if claim/route.ts relaxes or tightens a gate, /start may diverge
 * until this file is updated. A future refactor can extract the SQL predicates
 * from claim/route.ts and import them here instead.
 */

import { db } from '@buildd/core/db';
import {
  workspaceSkills,
  connectors,
  connectorShares,
  connectorWorkspaces,
  missions,
  workers,
} from '@buildd/core/db/schema';
import { eq, and, or, isNull, inArray } from 'drizzle-orm';
import { hasCodexCredential } from '@/lib/codex-credential';

/**
 * Check whether the task's role requires connectors that are not visible in its
 * workspace. Returns the list of missing connector names/IDs, or null when all
 * connectors are available (or the task has no role / the role has no refs).
 */
export async function checkConnectorRouting(
  roleSlug: string,
  workspaceId: string,
  teamId: string,
): Promise<string[] | null> {
  const roleRows = await db.query.workspaceSkills.findMany({
    where: and(
      eq(workspaceSkills.slug, roleSlug),
      eq(workspaceSkills.isRole, true),
      eq(workspaceSkills.enabled, true),
      eq(workspaceSkills.teamId, teamId),
      or(
        isNull(workspaceSkills.workspaceId),
        eq(workspaceSkills.workspaceId, workspaceId),
      ),
    ),
    columns: { slug: true, workspaceId: true, connectorRefs: true },
  });

  // Prefer workspace-scoped row over team default (same precedence as claim route)
  const roleRow =
    roleRows.find(r => r.workspaceId === workspaceId) ?? roleRows[0];
  if (!roleRow) return null;

  const refs = (roleRow.connectorRefs as string[] | null) ?? [];
  if (refs.length === 0) return null;

  const connectorRows = await db.query.connectors.findMany({
    where: inArray(connectors.id, refs),
    columns: { id: true, teamId: true, name: true },
  });
  const connectorById = new Map(connectorRows.map(c => [c.id, c]));

  const shareRows = await db.query.connectorShares.findMany({
    where: and(
      eq(connectorShares.sharedWithTeamId, teamId),
      inArray(connectorShares.connectorId, refs),
    ),
    columns: { connectorId: true },
  });
  const sharedIds = new Set(shareRows.map(s => s.connectorId));

  const cwRows = await db.query.connectorWorkspaces.findMany({
    where: and(
      eq(connectorWorkspaces.workspaceId, workspaceId),
      inArray(connectorWorkspaces.connectorId, refs),
    ),
    columns: { connectorId: true, enabled: true },
  });
  const cwEnabled = new Map<string, boolean>();
  for (const row of cwRows) {
    cwEnabled.set(row.connectorId, (row as any).enabled !== false);
  }

  const missing: string[] = [];
  for (const refId of refs) {
    const connector = connectorById.get(refId);
    if (!connector) {
      missing.push(refId); // dangling ref — connector deleted or not visible
      continue;
    }
    if (connector.teamId !== teamId && !sharedIds.has(refId)) {
      missing.push(connector.name);
      continue;
    }
    if (cwEnabled.has(refId) && !cwEnabled.get(refId)) {
      missing.push(connector.name);
    }
  }

  return missing.length > 0 ? missing : null;
}

/**
 * Check whether the task's mission is held. Returns true when the claim route
 * would reject this task via the missionNotHeld() SQL gate.
 *
 * The call site is responsible for checking bypassHeldGate / forceOverride
 * before invoking this helper — it is only called when those guards are clear.
 */
export async function checkMissionHeld(missionId: string): Promise<boolean> {
  const mission = await db.query.missions.findFirst({
    where: and(
      eq(missions.id, missionId),
      eq(missions.isHeld, true),
    ),
    columns: { id: true },
  });
  return !!mission;
}

/**
 * Check whether the task's backend is available server-side.
 * For codex-backend tasks, verifies that at least one Codex credential exists
 * for the team/workspace. Returns the missing capability string or null when OK.
 *
 * Note: runner-side requiredCapabilities cannot be verified here — the server
 * has no registry of active runner capabilities. This gate catches the common
 * server-verifiable case: a codex-backend task with no credentials configured.
 * A local runner with its own OPENAI_API_KEY or CODEX_HOME can still claim the
 * task; if one is running, forceOverride lets the user bypass this gate.
 */
export async function checkCapabilityMatch(opts: {
  backend: string;
  workspaceId: string;
  teamId: string;
  accountId?: string | null;
}): Promise<string | null> {
  if (opts.backend !== 'codex') return null;
  const ok = await hasCodexCredential({
    teamId: opts.teamId,
    workspaceId: opts.workspaceId,
    accountId: opts.accountId ?? null,
  });
  return ok ? null : 'backend:codex';
}

/**
 * Check whether the workspace is at its per-repo concurrency cap. Only applies
 * to repo-backed workspaces (repo-less ones are never capped). Returns
 * { active, cap } when the cap is reached, or null when the task can proceed.
 */
export async function checkWorkspaceCap(
  workspaceId: string,
  maxConcurrentTasks: number | null,
): Promise<{ active: number; cap: number } | null> {
  const cap = maxConcurrentTasks ?? 3;
  const activeWorkers = await db.query.workers.findMany({
    where: and(
      eq(workers.workspaceId, workspaceId),
      inArray(workers.status, ['running', 'starting', 'idle']),
    ),
    columns: { id: true },
  });
  const active = activeWorkers.length;
  return active >= cap ? { active, cap } : null;
}
