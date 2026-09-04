/**
 * Connector availability pre-filter.
 *
 * Tasks whose role declares connectorRefs are only claimable by a worker in a
 * workspace where EVERY referenced connector is visible (owned or shared to
 * this team), not explicitly disabled, has valid credentials, and is reachable.
 * Tasks with connector failures are silently deferred so a correctly-routed or
 * fixed-up worker can claim them later.
 *
 * Failure taxonomy (evaluated in order — the order IS the contract, because the
 * mode reported to the caller is the first one that matches):
 *   never_mounted      — dangling ref / wrong team / disabled for workspace
 *   expired_or_revoked — credential missing, oauth token expired, or undecryptable
 *   transient          — HTTP HEAD probe failed (transport=http only; 5s budget)
 *
 * This runs before the claim loop and only reads. It reports; the caller decides
 * what to do — defer the task, claim it with a degraded notice, or (for an
 * explicit single-task claim) reject with 422.
 */
import { db } from '@buildd/core/db';
import {
  connectors,
  connectorShares,
  connectorWorkspaces,
  secrets,
  workspaceSkills,
} from '@buildd/core/db/schema';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { getSecretsProvider } from '@buildd/core/secrets';

/** One connector that failed availability, with the first taxonomy mode that matched. */
export type ConnectorFailure = { connectorId: string; connectorName: string; mode: string };

/** What the pre-filter learned about the candidate tasks. */
export type ConnectorPreFilter = {
  /** Tasks to skip: their role's connectors are unavailable and not waivable. */
  connectorMismatchTaskIds: Set<string>;
  /** Per-task typed failures — shapes the 422 body for an explicit taskId claim. */
  taskConnectorFailures: Map<string, ConnectorFailure[]>;
  /** Subset of taskConnectorFailures limited to task.requiredConnectors (drives notifications). */
  taskRequiredConnectorFailures: Map<string, ConnectorFailure[]>;
  /** Advisory mode: failing-but-not-required connectors the task claims anyway with. */
  taskDegradedConnectors: Map<string, Array<{ id: string; name: string; failureMode: string }>>;
};

/**
 * Classify connector availability for every candidate task that declares a role.
 *
 * Tasks with no roleSlug or no team are not considered — a task that opts into
 * no connectors can never fail this filter.
 */
export async function runConnectorPreFilter(
  filteredTasks: readonly any[],
): Promise<ConnectorPreFilter> {
  const connectorMismatchTaskIds = new Set<string>();
  const taskConnectorFailures = new Map<string, ConnectorFailure[]>();
  const taskRequiredConnectorFailures = new Map<string, ConnectorFailure[]>();
  const taskDegradedConnectors = new Map<string, Array<{ id: string; name: string; failureMode: string }>>();

  const rolePairs = filteredTasks
    .map(t => ({
      taskId: t.id,
      taskWorkspaceId: t.workspaceId,
      roleSlug: (t as any).roleSlug as string | null,
      teamId: (t as any).workspace?.teamId as string | undefined,
    }))
    .filter((p): p is { taskId: string; taskWorkspaceId: string; roleSlug: string; teamId: string } =>
      !!p.roleSlug && !!p.teamId,
    );

  if (rolePairs.length > 0) {
    const slugsToFetch = [...new Set(rolePairs.map(p => p.roleSlug))];
    const teamIdsToFetch = [...new Set(rolePairs.map(p => p.teamId))];
    const wsIdsToFetch = [...new Set(rolePairs.map(p => p.taskWorkspaceId))];

    // Batch-fetch role rows for all relevant (teamId, roleSlug) combos.
    const preFilterRoleRows = await db.query.workspaceSkills.findMany({
      where: and(
        inArray(workspaceSkills.slug, slugsToFetch),
        eq(workspaceSkills.isRole, true),
        eq(workspaceSkills.enabled, true),
        inArray(workspaceSkills.teamId, teamIdsToFetch),
        or(
          isNull(workspaceSkills.workspaceId),
          inArray(workspaceSkills.workspaceId, wsIdsToFetch),
        ),
      ),
      columns: { slug: true, teamId: true, workspaceId: true, connectorRefs: true },
    });

    // Effective connectorRefs per (teamId|slug|wsId) — workspace-scoped row wins.
    const effectiveRoleMap = new Map<string, string[]>();
    for (const row of preFilterRoleRows) {
      const refs = ((row as any).connectorRefs as string[] | null) ?? [];
      if (refs.length === 0) continue;
      const wsId = (row as any).workspaceId as string | null;
      const teamId = (row as any).teamId as string;
      effectiveRoleMap.set(`${teamId}|${row.slug}|${wsId ?? '*'}`, refs);
    }
    const getConnectorRefs = (teamId: string, slug: string, wsId: string): string[] =>
      effectiveRoleMap.get(`${teamId}|${slug}|${wsId}`) ??
      effectiveRoleMap.get(`${teamId}|${slug}|*`) ??
      [];

    // Collect all connector IDs referenced by any of the tasks' roles.
    const allRefIds = new Set<string>();
    for (const pair of rolePairs) {
      for (const ref of getConnectorRefs(pair.teamId, pair.roleSlug, pair.taskWorkspaceId)) {
        allRefIds.add(ref);
      }
    }

    if (allRefIds.size > 0) {
      const refIdList = [...allRefIds];

      // Batch-fetch connector metadata — include authMode/transport/url for
      // expired_or_revoked and transient classification.
      const preFilterConnectors = await db.query.connectors.findMany({
        where: inArray(connectors.id, refIdList),
        columns: { id: true, teamId: true, name: true, authMode: true, transport: true, url: true, envMapping: true },
      });
      const connectorById = new Map(preFilterConnectors.map(c => [c.id, c]));

      // Batch-fetch cross-team share grants so shared connectors are treated
      // as visible even when teamId differs.
      const preFilterShares = await db.query.connectorShares.findMany({
        where: and(
          inArray(connectorShares.sharedWithTeamId, teamIdsToFetch),
          inArray(connectorShares.connectorId, refIdList),
        ),
        columns: { connectorId: true, sharedWithTeamId: true },
      });
      const sharedByTeam = new Map<string, Set<string>>();
      for (const s of preFilterShares) {
        if (!sharedByTeam.has(s.sharedWithTeamId)) sharedByTeam.set(s.sharedWithTeamId, new Set());
        sharedByTeam.get(s.sharedWithTeamId)!.add(s.connectorId);
      }

      // Batch-fetch connector-workspace enabled rows. An absent row means the
      // connector is enabled by default (same semantics as the injection block).
      const preFilterCwRows = await db.query.connectorWorkspaces.findMany({
        where: and(
          inArray(connectorWorkspaces.workspaceId, wsIdsToFetch),
          inArray(connectorWorkspaces.connectorId, refIdList),
        ),
        columns: { connectorId: true, workspaceId: true, enabled: true },
      });
      const cwEnabled = new Map<string, boolean>();
      for (const row of preFilterCwRows) {
        cwEnabled.set(`${row.workspaceId}|${row.connectorId}`, row.enabled !== false);
      }

      // ── expired_or_revoked: batch credential checks ───────────────────────
      // Only runs when ENCRYPTION_KEY is present; otherwise skipped gracefully.
      const credFailedIds = new Set<string>(); // connectors with expired/revoked creds
      if (process.env.ENCRYPTION_KEY) {
        const now = new Date();
        const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

        // oauth/header connectors: mcp_connector_credential, label = connectorId
        const authConnectors = preFilterConnectors.filter(
          c => c.authMode === 'oauth' || c.authMode === 'header',
        );
        if (authConnectors.length > 0) {
          const ownerTeamIds = [...new Set(authConnectors.map(c => c.teamId))];
          const credSecretRows = await db.query.secrets.findMany({
            where: and(
              inArray(secrets.teamId, ownerTeamIds),
              eq(secrets.purpose, 'mcp_connector_credential'),
              inArray(secrets.label, authConnectors.map(c => c.id)),
            ),
            columns: { id: true, label: true, tokenExpiresAt: true, lastRefreshedAt: true },
          });
          const secretByConnId = new Map(
            credSecretRows.filter(s => s.label).map(s => [s.label!, s]),
          );
          const credProvider = getSecretsProvider();

          for (const connector of authConnectors) {
            const secret = secretByConnId.get(connector.id);
            if (connector.authMode === 'oauth') {
              if (!secret) { credFailedIds.add(connector.id); continue; }
              const expiresAt = secret.tokenExpiresAt;
              const refreshedAt = secret.lastRefreshedAt;
              if (expiresAt && expiresAt < now && (!refreshedAt || refreshedAt < fiveMinAgo)) {
                credFailedIds.add(connector.id);
              }
            } else {
              // header: try decryption
              if (!secret) { credFailedIds.add(connector.id); continue; }
              try {
                const val = await credProvider.get(secret.id);
                if (!val) credFailedIds.add(connector.id);
              } catch {
                credFailedIds.add(connector.id);
              }
            }
          }
        }

        // stdio connectors: mcp_credential secrets via envMapping values
        const stdioConnectors = preFilterConnectors.filter(
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
            const credProvider = getSecretsProvider();
            for (const connector of stdioConnectors) {
              const mapping = (connector.envMapping as Record<string, string> | null) ?? {};
              const labels = Object.values(mapping);
              if (labels.length === 0) continue;
              let credOk = true;
              for (const label of labels) {
                const sr = envSecretByTeamLabel.get(`${connector.teamId}\0${label}`);
                if (!sr) { credOk = false; break; }
                try {
                  const val = await credProvider.get(sr.id);
                  if (!val) { credOk = false; break; }
                } catch { credOk = false; break; }
              }
              if (!credOk) credFailedIds.add(connector.id);
            }
          }
        }
      }

      // ── transient: HTTP HEAD probe for http connectors ────────────────────
      // 3s per connector, 5s total budget across the entire claim call.
      // Connectors already classified (never_mounted or expired_or_revoked)
      // are skipped — we'll know their IDs after the pass-1 loop below.
      // We pre-classify all http connectors that are visible and credentialed,
      // then probe them. Store results keyed by connectorId.
      const transientIds = new Set<string>();
      const httpProbeCandidates = preFilterConnectors.filter(
        c => c.transport === 'http' && !credFailedIds.has(c.id),
      );
      if (httpProbeCandidates.length > 0) {
        const budgetStart = Date.now();
        const probeBudgetMs = 5000;
        for (const connector of httpProbeCandidates) {
          const spent = Date.now() - budgetStart;
          if (spent >= probeBudgetMs) {
            transientIds.add(connector.id);
            continue;
          }
          const timeoutMs = Math.min(3000, probeBudgetMs - spent);
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), timeoutMs);
          try {
            await fetch(connector.url, { method: 'HEAD', signal: ac.signal });
            clearTimeout(timer);
          } catch {
            clearTimeout(timer);
            transientIds.add(connector.id);
          }
        }
      }

      // ── Pass 1: classify per-task failures ────────────────────────────────
      for (const pair of rolePairs) {
        const refs = getConnectorRefs(pair.teamId, pair.roleSlug, pair.taskWorkspaceId);
        if (refs.length === 0) continue;

        const failures: Array<{ connectorId: string; connectorName: string; mode: string }> = [];
        for (const refId of refs) {
          const connector = connectorById.get(refId);
          if (!connector) {
            failures.push({ connectorId: refId, connectorName: refId, mode: 'never_mounted' });
            continue;
          }
          // Visibility check: connector must be owned by the task's team or shared to it.
          const sharedSet = sharedByTeam.get(pair.teamId) ?? new Set<string>();
          if (connector.teamId !== pair.teamId && !sharedSet.has(refId)) {
            failures.push({ connectorId: refId, connectorName: connector.name, mode: 'never_mounted' });
            continue;
          }
          // Enabled check: an explicit false row disables the connector for this workspace.
          const cwKey = `${pair.taskWorkspaceId}|${refId}`;
          if (cwEnabled.has(cwKey) && !cwEnabled.get(cwKey)) {
            failures.push({ connectorId: refId, connectorName: connector.name, mode: 'never_mounted' });
            continue;
          }
          // Credential check
          if (credFailedIds.has(refId)) {
            failures.push({ connectorId: refId, connectorName: connector.name, mode: 'expired_or_revoked' });
            continue;
          }
          // Transient check
          if (transientIds.has(refId)) {
            failures.push({ connectorId: refId, connectorName: connector.name, mode: 'transient' });
          }
        }

        if (failures.length > 0) {
          taskConnectorFailures.set(pair.taskId, failures);

          // Advisory-mode check: when the workspace has connectorAdvisoryMode=true,
          // tasks with no hard-required failing connectors claim with a degradedConnectors
          // notice instead of being blocked — unless total degradation (ALL role connectors
          // are unavailable), which always holds the task regardless of the flag.
          const task = filteredTasks.find(t => t.id === pair.taskId);
          const wsAdvisory = (task as any)?.workspace?.connectorAdvisoryMode === true;
          const requiredConnectors = (task as any)?.requiredConnectors as string[] | null ?? null;
          const failedIds = new Set(failures.map(f => f.connectorId));
          const hasRequiredFailure = requiredConnectors?.some(id => failedIds.has(id)) ?? false;
          const totalDegradation = failures.length === refs.length;

          if (wsAdvisory && !hasRequiredFailure && !totalDegradation) {
            // Partial degradation in advisory mode: claim proceeds with degradedConnectors.
            taskDegradedConnectors.set(pair.taskId, failures.map(f => ({
              id: f.connectorId,
              name: f.connectorName,
              failureMode: f.mode,
            })));
            const detail = failures.map(f => `'${f.connectorName}' (${f.mode})`).join(', ');
            console.log(
              `[claim] Advisory: task ${pair.taskId} claiming with degraded connectors [${detail}] in workspace ${pair.taskWorkspaceId}`,
            );
          } else {
            connectorMismatchTaskIds.add(pair.taskId);
            const detail = failures.map(f => `'${f.connectorName}' (${f.mode})`).join(', ');
            const reason = totalDegradation && wsAdvisory ? 'total degradation' : 'connector mismatch';
            console.log(
              `[claim] Skipped task ${pair.taskId} (${reason}): role ${pair.roleSlug} has connector issues [${detail}] in workspace ${pair.taskWorkspaceId}`,
            );
            // Track required-connector failures for notifications. If the task has
            // explicit requiredConnectors, only track failures on those IDs so the
            // alert is specific to what the task declared as mandatory.
            if (requiredConnectors?.length) {
              const requiredFailures = failures.filter(f => requiredConnectors.includes(f.connectorId));
              if (requiredFailures.length > 0) {
                taskRequiredConnectorFailures.set(pair.taskId, requiredFailures);
              }
            }
          }
        }
      }
    }
  }

  return {
    connectorMismatchTaskIds,
    taskConnectorFailures,
    taskRequiredConnectorFailures,
    taskDegradedConnectors,
  };
}
