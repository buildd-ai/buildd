import { db } from '@buildd/core/db';
import {
  workspaceSkills,
  connectors,
  connectorShares,
  connectorWorkspaces,
  secrets,
} from '@buildd/core/db/schema';
import { eq, and, inArray, ne } from 'drizzle-orm';
import {
  effectiveVisibleRoles,
  lazyRequester,
  pickVisibleRoleRowLazy,
  ROLE_VISIBILITY_COLUMNS,
  roleRowsInScope,
  roleRowsVisibleTo,
} from '@buildd/core/role-visibility';
import { getSecretsProvider } from '@buildd/core/secrets';
import { teamCredentialWhere } from '@buildd/core/secrets/team-scope';
import { loadBlockedCatalogs, connectorBlock } from '@/lib/connector-access-policy';

// ── Typed connector failure taxonomy ─────────────────────────────────────────

export type ConnectorFailureMode = 'never_mounted' | 'blocked_by_policy' | 'expired_or_revoked' | 'transient';

/**
 * A typed failure for a single connector that a role requires.
 *
 * - never_mounted:      connector doesn't exist, belongs to a different team, or is disabled
 * - blocked_by_policy:  the task's team (or the connector's owner team) blocked its catalog entry;
 *                       the connector and its credential are kept, agents just may not use it
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
 * `probe: false` skips the HTTP pass. Who the task is for decides which
 * personal role applies: pass `task` (requester resolved lazily) or an
 * already-known `requesterUserId`; neither = no person (team and shared roles).
 */
export interface ConnectorRoutingOpts {
  probe?: boolean;
  task?: object | null;
  requesterUserId?: string | null;
}

function requesterThunk(opts: ConnectorRoutingOpts): () => Promise<string | null> {
  if (opts.requesterUserId !== undefined) return async () => opts.requesterUserId ?? null;
  return lazyRequester(opts.task);
}

/**
 * Check whether the task's role requires connectors that are not usable in its
 * workspace. Returns a list of typed failures (with mode), or null when all
 * connectors are available and healthy.
 *
 * Used by both the claim route (for explicit single-task 422s) and
 * /api/tasks/[id]/start (for pre-broadcast gate checks). This is the single
 * canonical per-task implementation — the claim route's bulk SQL pre-filter
 * still handles throughput, but this function is the authoritative check.
 *
 * Failure modes (in evaluation order):
 * 1. never_mounted      — connector not in DB / wrong team / disabled for this workspace
 *    blocked_by_policy  — team catalog policy blocks it (lib/connector-access-policy.ts)
 * 2. expired_or_revoked — credential missing, expired (oauth), or undecryptable (header/stdio)
 * 3. transient          — HTTP HEAD probe failed within budget; skips stdio connectors
 *
 * `probe: false` skips pass 3: role routing (lib/task-role-decision.ts) needs
 * only the durable modes, and a transient failure is no reason to route away.
 */
export async function checkConnectorRouting(
  roleSlug: string,
  workspaceId: string,
  teamId: string,
  opts: ConnectorRoutingOpts = {},
): Promise<ConnectorFailure[] | null> {
  const roleRows = await db.query.workspaceSkills.findMany({
    where: and(
      eq(workspaceSkills.slug, roleSlug),
      eq(workspaceSkills.isRole, true),
      eq(workspaceSkills.enabled, true),
      roleRowsInScope({ teamId, workspaceId }),
    ),
    columns: { ...ROLE_VISIBILITY_COLUMNS, connectorRefs: true },
  });

  // Same precedence as the claim route (role-visibility.ts): override > own
  // personal > shared personal > team default; never another member's private row.
  const roleRow = await pickVisibleRoleRowLazy(roleRows, roleSlug, { teamId, workspaceId }, requesterThunk(opts));
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

  const blockedCatalogs = await loadBlockedCatalogs([teamId, ...connectorRows.map(c => c.teamId)]);

  // ── Pass 1: visibility checks → never_mounted, then blocked_by_policy ─────

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
    if (connectorBlock(connector, teamId, blockedCatalogs)) {
      failures.push({ connectorId: refId, connectorName: connector.name, mode: 'blocked_by_policy' });
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
        where: teamCredentialWhere({ teamId: ownerTeamIds, purpose: 'mcp_connector_credential', label: authConnectors.map(c => c.id) }),
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
          where: teamCredentialWhere({ teamId: ownerTeamIds, purpose: 'mcp_credential', label: envLabels }),
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
  const httpToProbe = opts.probe === false ? [] : visibleConnectors.filter(
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
 * Find an alternative role in the same workspace that could run the task.
 * Returns the slug of the first sibling role that:
 *   - is enabled, isRole=true, different slug than blockedRoleSlug
 *   - has no connectorRefs (or all refs pass checkConnectorRouting)
 * Returns null when no viable alternative exists.
 */
export async function findAlternativeRole(
  blockedRoleSlug: string,
  workspaceId: string,
  teamId: string,
  opts: Omit<ConnectorRoutingOpts, 'probe'> = {},
): Promise<string | null> {
  const requesterUserId = await requesterThunk(opts)();
  const siblingRows = await db.query.workspaceSkills.findMany({
    where: and(
      eq(workspaceSkills.isRole, true),
      eq(workspaceSkills.enabled, true),
      ne(workspaceSkills.slug, blockedRoleSlug),
      roleRowsVisibleTo({ teamId, workspaceId, requesterUserId }),
    ),
    columns: { ...ROLE_VISIBILITY_COLUMNS, connectorRefs: true },
  });

  // One row per slug, by the shared precedence; another member's private role
  // is never offered as the alternative.
  for (const role of effectiveVisibleRoles(siblingRows, { teamId, workspaceId, requesterUserId })) {
    const refs = (role.connectorRefs as string[] | null) ?? [];
    if (refs.length === 0) return role.slug;
    const failures = await checkConnectorRouting(role.slug, workspaceId, teamId, { requesterUserId });
    if (!failures) return role.slug;
  }

  return null;
}
