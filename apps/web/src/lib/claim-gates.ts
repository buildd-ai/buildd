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
  secrets,
} from '@buildd/core/db/schema';
import { eq, and, or, isNull, inArray } from 'drizzle-orm';
import { hasCodexCredential } from '@/lib/codex-credential';
import { getSecretsProvider } from '@buildd/core/secrets';

// ── Typed connector failure taxonomy ─────────────────────────────────────────

export type ConnectorFailureMode = 'never_mounted' | 'expired_or_revoked' | 'transient';

/**
 * A typed failure for a single connector that a role requires.
 *
 * - never_mounted:      connector doesn't exist, belongs to a different team, or is disabled
 * - expired_or_revoked: connector exists but its credential is missing, expired, or corrupt
 * - transient:          connector is visible and credentialed but unreachable via HTTP probe
 */
export interface ConnectorFailure {
  connectorId: string;
  connectorName: string;
  mode: ConnectorFailureMode;
}

// ── HTTP probe constants ──────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 3000;
const PROBE_BUDGET_MS = 5000;

// ── checkConnectorRouting ─────────────────────────────────────────────────────

/**
 * Check whether the task's role requires connectors that are not usable in its
 * workspace. Returns a list of typed failures (with mode), or null when all
 * connectors are available and healthy.
 *
 * Failure modes (in evaluation order):
 * 1. never_mounted      — connector not in DB / wrong team / disabled for this workspace
 * 2. expired_or_revoked — credential missing, expired (oauth), or undecryptable (header/stdio)
 * 3. transient          — HTTP HEAD probe failed within budget; skips stdio connectors
 */
export async function checkConnectorRouting(
  roleSlug: string,
  workspaceId: string,
  teamId: string,
): Promise<ConnectorFailure[] | null> {
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
    columns: { id: true, teamId: true, name: true, authMode: true, transport: true, url: true, envMapping: true },
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

  // ── Pass 1: visibility checks → never_mounted ─────────────────────────────

  const failures: ConnectorFailure[] = [];
  type ConnectorRow = (typeof connectorRows)[number];
  const visibleConnectors: ConnectorRow[] = [];

  for (const refId of refs) {
    const connector = connectorById.get(refId);
    if (!connector) {
      failures.push({ connectorId: refId, connectorName: refId, mode: 'never_mounted' });
      continue;
    }
    if (connector.teamId !== teamId && !sharedIds.has(refId)) {
      failures.push({ connectorId: refId, connectorName: connector.name, mode: 'never_mounted' });
      continue;
    }
    if (cwEnabled.has(refId) && !cwEnabled.get(refId)) {
      failures.push({ connectorId: refId, connectorName: connector.name, mode: 'never_mounted' });
      continue;
    }
    visibleConnectors.push(connector);
  }

  if (visibleConnectors.length === 0) {
    return failures.length > 0 ? failures : null;
  }

  // ── Pass 2: credential checks → expired_or_revoked ───────────────────────
  // Gated on ENCRYPTION_KEY: without it we can't decrypt, so skip gracefully.

  const credFailedIds = new Set<string>();

  if (process.env.ENCRYPTION_KEY) {
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

    // oauth and header connectors: mcp_connector_credential secret keyed by connectorId
    const authConnectors = visibleConnectors.filter(
      c => c.authMode === 'oauth' || c.authMode === 'header',
    );

    if (authConnectors.length > 0) {
      const ownerTeamIds = [...new Set(authConnectors.map(c => c.teamId))];
      const secretRows = await db.query.secrets.findMany({
        where: and(
          inArray(secrets.teamId, ownerTeamIds),
          eq(secrets.purpose, 'mcp_connector_credential'),
          inArray(secrets.label, authConnectors.map(c => c.id)),
        ),
        columns: { id: true, label: true, tokenExpiresAt: true, lastRefreshedAt: true },
      });
      const secretByConnId = new Map(secretRows.filter(s => s.label).map(s => [s.label!, s]));
      const provider = getSecretsProvider();

      for (const connector of authConnectors) {
        const secret = secretByConnId.get(connector.id);

        if (connector.authMode === 'oauth') {
          if (!secret) {
            failures.push({ connectorId: connector.id, connectorName: connector.name, mode: 'expired_or_revoked' });
            credFailedIds.add(connector.id);
            continue;
          }
          const expiresAt = secret.tokenExpiresAt;
          const refreshedAt = secret.lastRefreshedAt;
          if (expiresAt && expiresAt < now && (!refreshedAt || refreshedAt < fiveMinAgo)) {
            failures.push({ connectorId: connector.id, connectorName: connector.name, mode: 'expired_or_revoked' });
            credFailedIds.add(connector.id);
          }
        } else {
          // header auth: try to decrypt the secret
          if (!secret) {
            failures.push({ connectorId: connector.id, connectorName: connector.name, mode: 'expired_or_revoked' });
            credFailedIds.add(connector.id);
            continue;
          }
          try {
            const val = await provider.get(secret.id);
            if (!val) {
              failures.push({ connectorId: connector.id, connectorName: connector.name, mode: 'expired_or_revoked' });
              credFailedIds.add(connector.id);
            }
          } catch {
            failures.push({ connectorId: connector.id, connectorName: connector.name, mode: 'expired_or_revoked' });
            credFailedIds.add(connector.id);
          }
        }
      }
    }

    // stdio connectors: check envMapping secrets (purpose=mcp_credential)
    const stdioConnectors = visibleConnectors.filter(
      c => c.transport === 'stdio' && c.authMode !== 'none' && !credFailedIds.has(c.id),
    );

    if (stdioConnectors.length > 0) {
      const ownerTeamIds = [...new Set(stdioConnectors.map(c => c.teamId))];
      const envLabels = [
        ...new Set(
          stdioConnectors.flatMap(c => Object.values((c.envMapping as Record<string, string> | null) ?? {})),
        ),
      ];

      if (envLabels.length > 0) {
        const envSecretRows = await db.query.secrets.findMany({
          where: and(
            inArray(secrets.teamId, ownerTeamIds),
            eq(secrets.purpose, 'mcp_credential'),
            inArray(secrets.label, envLabels),
          ),
          columns: { id: true, label: true, teamId: true },
        });
        const envSecretByTeamLabel = new Map(
          envSecretRows.filter(s => s.label && s.teamId).map(s => [`${s.teamId}\0${s.label}`, s]),
        );
        const provider = getSecretsProvider();

        for (const connector of stdioConnectors) {
          const mapping = (connector.envMapping as Record<string, string> | null) ?? {};
          const labels = Object.values(mapping);
          if (labels.length === 0) continue;

          let credOk = true;
          for (const label of labels) {
            const secretRow = envSecretByTeamLabel.get(`${connector.teamId}\0${label}`);
            if (!secretRow) { credOk = false; break; }
            try {
              const val = await provider.get(secretRow.id);
              if (!val) { credOk = false; break; }
            } catch {
              credOk = false;
              break;
            }
          }

          if (!credOk) {
            failures.push({ connectorId: connector.id, connectorName: connector.name, mode: 'expired_or_revoked' });
            credFailedIds.add(connector.id);
          }
        }
      } else {
        // Has envMapping keys but no labels — treat as misconfigured (expired_or_revoked)
        for (const connector of stdioConnectors) {
          const mapping = (connector.envMapping as Record<string, string> | null) ?? {};
          if (Object.keys(mapping).length > 0 && Object.values(mapping).length === 0) {
            failures.push({ connectorId: connector.id, connectorName: connector.name, mode: 'expired_or_revoked' });
            credFailedIds.add(connector.id);
          }
        }
      }
    }
  }

  // ── Pass 3: transient HTTP probe ──────────────────────────────────────────
  // Only for http connectors not already classified above.

  const alreadyFailedIds = new Set([...failures.map(f => f.connectorId)]);
  const httpToProbe = visibleConnectors.filter(
    c => c.transport === 'http' && !alreadyFailedIds.has(c.id),
  );

  if (httpToProbe.length > 0) {
    const budgetStart = Date.now();

    for (const connector of httpToProbe) {
      const spent = Date.now() - budgetStart;
      if (spent >= PROBE_BUDGET_MS) {
        failures.push({ connectorId: connector.id, connectorName: connector.name, mode: 'transient' });
        continue;
      }
      const timeoutMs = Math.min(PROBE_TIMEOUT_MS, PROBE_BUDGET_MS - spent);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        await fetch(connector.url, { method: 'HEAD', signal: ac.signal });
        clearTimeout(timer);
        // Any response (including 4xx/5xx) means the server is reachable
      } catch {
        clearTimeout(timer);
        failures.push({ connectorId: connector.id, connectorName: connector.name, mode: 'transient' });
      }
    }
  }

  return failures.length > 0 ? failures : null;
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
