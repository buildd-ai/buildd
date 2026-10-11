/**
 * The connector gateway's db half (rules: connector-gateway.ts).
 *
 * Every request re-reads every fact a decision needs: the task, the worker,
 * the task's role and its connectorRefs, connector visibility and workspace
 * enablement, the team's catalog block, the credential's health and team
 * capability policy. Nothing is cached from claim time, so a role change, a
 * block, a revoke or an ended task stops the next call.
 *
 * The provider credential is decrypted here, per request, under the
 * connector's OWNER team, and only ever goes into the outbound request to the
 * connector's own URL. It is never returned, logged or audited.
 */
import { db } from '@buildd/core/db';
import {
  agentCapabilityDecisions,
  connectorShares,
  connectorWorkspaces,
  connectors,
  missions,
  secrets,
  tasks,
  workers,
  workspaceSkills,
} from '@buildd/core/db/schema';
import { getSecretsProvider } from '@buildd/core/secrets';
import { teamCredentialWhere } from '@buildd/core/secrets/team-scope';
import { lazyRequester, pickVisibleRoleRowLazy, ROLE_VISIBILITY_COLUMNS } from '@buildd/core/role-visibility';
import { and, eq, gt, isNull, like, or, sql } from 'drizzle-orm';
import { connectorHostKey } from './connector-catalog';
import { loadTeamCatalog } from './connector-catalog-store';
import { checkConnectorBlocked } from './connector-access-policy';
import { refreshMcpConnectorCredential } from './mcp-connector-refresh';
import { loadPolicyRules } from './capability-grants-store';
import { readRoleCeiling, type CredentialState, type GatewayRun } from './connector-gateway';
import type { AgentPrincipal } from './agent-capabilities/principal';

type ConnectorRow = typeof connectors.$inferSelect;

export interface LoadedGateway {
  run: GatewayRun;
  connector: Pick<ConnectorRow, 'id' | 'name' | 'url' | 'authMode' | 'headerName' | 'teamId' | 'transport' | 'discoveredMetadata'>;
  secret: { id: string; tokenExpiresAt: Date | null } | null;
}

/** The catalog slug serving this URL for the team (host match), or null. */
export async function providerSlugFor(teamId: string, url: string): Promise<string | null> {
  const key = connectorHostKey(url);
  if (!key) return null;
  const catalog = await loadTeamCatalog(teamId);
  return catalog.find(e => connectorHostKey(e.url) === key)?.slug ?? null;
}

/**
 * Load the live run state for one connector request. Null when the connector
 * does not exist or this team cannot see it (the route answers 404 either way).
 * Throws on a db failure: the route fails closed.
 */
export async function loadGatewayRun(principal: AgentPrincipal, connectorId: string): Promise<LoadedGateway | null> {
  const teamId = principal.teamId;
  if (!teamId) return null;

  const [connector, task, worker] = await Promise.all([
    db.query.connectors.findFirst({ where: eq(connectors.id, connectorId) }),
    db.query.tasks.findFirst({
      where: eq(tasks.id, principal.taskId),
      columns: { id: true, status: true, roleSlug: true, workspaceId: true, scheduleId: true, missionId: true, createdByUserId: true, parentTaskId: true },
    }),
    db.query.workers.findFirst({ where: eq(workers.id, principal.workerId), columns: { status: true } }),
  ]);
  if (!connector) return null;

  const shared = connector.teamId === teamId ? null : await db.query.connectorShares.findFirst({
    where: and(eq(connectorShares.connectorId, connector.id), eq(connectorShares.sharedWithTeamId, teamId)),
    columns: { connectorId: true },
  });
  const visible = connector.teamId === teamId || !!shared;
  if (!visible) return null;

  const roleSlug = task?.roleSlug ?? null;
  const [cw, block, roleRows, missionRow, secretRow, provider, rules] = await Promise.all([
    db.query.connectorWorkspaces.findFirst({
      where: and(eq(connectorWorkspaces.connectorId, connector.id), eq(connectorWorkspaces.workspaceId, principal.workspaceId)),
      columns: { enabled: true },
    }),
    checkConnectorBlocked(connector, teamId),
    roleSlug ? db.query.workspaceSkills.findMany({
      where: and(
        eq(workspaceSkills.slug, roleSlug), eq(workspaceSkills.isRole, true), eq(workspaceSkills.enabled, true),
        eq(workspaceSkills.teamId, teamId),
        or(isNull(workspaceSkills.workspaceId), eq(workspaceSkills.workspaceId, principal.workspaceId)),
      ),
      columns: { ...ROLE_VISIBILITY_COLUMNS, connectorRefs: true, metadata: true },
    }) : Promise.resolve([]),
    task?.missionId ? db.query.missions.findFirst({ where: eq(missions.id, task.missionId), columns: { scheduleId: true } }) : Promise.resolve(null),
    db.query.secrets.findFirst({
      where: teamCredentialWhere({ teamId: connector.teamId, purpose: 'mcp_connector_credential', label: connector.id }),
      columns: { id: true, tokenExpiresAt: true, healthStatus: true },
    }),
    providerSlugFor(teamId, connector.url),
    loadPolicyRules(teamId),
  ]);

  const role = roleSlug && task
    ? await pickVisibleRoleRowLazy(roleRows, roleSlug, { teamId, workspaceId: principal.workspaceId }, lazyRequester(task))
    : null;
  const refs = ((role as { connectorRefs?: string[] } | null)?.connectorRefs) ?? [];

  let credential: CredentialState = 'ok';
  if (!secretRow) credential = 'missing';
  else if (secretRow.healthStatus === 'revoked') credential = 'dead';

  return {
    run: {
      teamId,
      workspaceId: principal.workspaceId,
      taskId: principal.taskId,
      workerId: principal.workerId,
      roleSlug: role ? roleSlug : null,
      taskStatus: task?.status ?? 'missing',
      workerStatus: worker?.status ?? 'missing',
      unattended: !!task?.scheduleId || !!missionRow?.scheduleId,
      roleCeiling: readRoleCeiling((role as { metadata?: unknown } | null)?.metadata),
      roleMounts: refs.includes(connector.id),
      connector: {
        id: connector.id,
        provider: provider ?? `connector:${connector.name}`,
        visible,
        enabledInWorkspace: cw?.enabled !== false,
        blocked: !!block,
        credential,
      },
      rules,
    },
    connector: {
      id: connector.id, name: connector.name, url: connector.url, authMode: connector.authMode,
      headerName: connector.headerName, teamId: connector.teamId, transport: connector.transport,
      discoveredMetadata: connector.discoveredMetadata,
    },
    secret: secretRow ? { id: secretRow.id, tokenExpiresAt: secretRow.tokenExpiresAt ?? null } : null,
  };
}

// ── Credential (server-side only) ────────────────────────────────────────────

/**
 * The auth header for the outbound provider request, or null when there is no
 * usable credential. An expired OAuth access token is refreshed first.
 */
export async function providerAuthHeader(g: LoadedGateway, now: Date = new Date()): Promise<{ name: string; value: string } | null> {
  if (!g.secret) return null;
  if (g.connector.authMode === 'oauth' && g.secret.tokenExpiresAt && g.secret.tokenExpiresAt.getTime() < now.getTime()) {
    const r = await refreshMcpConnectorCredential(g.secret.id);
    if (r !== 'refreshed' && r !== 'locked') return null;
  }
  const raw = await getSecretsProvider().get(g.secret.id);
  if (!raw) return null;
  if (g.connector.authMode === 'header') {
    return g.connector.headerName ? { name: g.connector.headerName, value: raw } : null;
  }
  try {
    const token = (JSON.parse(raw) as { access_token?: unknown }).access_token;
    return typeof token === 'string' && token ? { name: 'Authorization', value: `Bearer ${token}` } : null;
  } catch {
    return null;
  }
}

/** After a provider 401: refresh once (oauth). True when a retry may succeed. */
export async function refreshAfterRejection(g: LoadedGateway): Promise<boolean> {
  if (!g.secret || g.connector.authMode !== 'oauth') return false;
  const r = await refreshMcpConnectorCredential(g.secret.id);
  return r === 'refreshed';
}

/**
 * The provider rejected the credential even after a refresh: mark it the way
 * the runner's mid-task 401 event does, so discovery, the claim pre-filter and
 * the Reconnect banner all see it. The credential row is kept.
 */
export async function markCredentialRejected(g: LoadedGateway): Promise<void> {
  await db.update(secrets)
    .set({ tokenExpiresAt: sql`NOW()`, lastVerificationError: 'gateway_401', updatedAt: sql`NOW()` })
    .where(teamCredentialWhere({ teamId: g.connector.teamId, purpose: 'mcp_connector_credential', label: g.connector.id }));
}

// ── Rate, replay, audit ──────────────────────────────────────────────────────

export const TOOL_CALL_CAPABILITY = 'connector.tool_call';
export const TOOL_RESULT_CAPABILITY = 'connector.tool_result';

/** Calls this worker sent to this connector in the last minute (allowed or refused). */
export async function recentCallCount(workerId: string, connectorId: string, now: Date = new Date()): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` })
    .from(agentCapabilityDecisions)
    .where(and(
      eq(agentCapabilityDecisions.workerId, workerId),
      eq(agentCapabilityDecisions.capability, TOOL_CALL_CAPABILITY),
      like(agentCapabilityDecisions.resource, `connector:${connectorId}/%`),
      gt(agentCapabilityDecisions.occurredAt, new Date(now.getTime() - 60_000)),
    ));
  return Number(row?.n ?? 0);
}

/** Has this exact write already been let through for this worker? */
export async function isReplayedCall(workerId: string, key: string): Promise<boolean> {
  const row = await db.query.agentCapabilityDecisions.findFirst({
    where: and(
      eq(agentCapabilityDecisions.workerId, workerId),
      eq(agentCapabilityDecisions.capability, TOOL_CALL_CAPABILITY),
      eq(agentCapabilityDecisions.decision, 'allowed'),
      sql`${agentCapabilityDecisions.sideEffect}->>'callKey' = ${key}`,
    ),
    columns: { id: true },
  });
  return !!row;
}

export interface ToolAuditRow {
  capability: typeof TOOL_CALL_CAPABILITY | typeof TOOL_RESULT_CAPABILITY;
  decision: 'allowed' | 'refused';
  principal: Pick<AgentPrincipal, 'workspaceId' | 'taskId' | 'workerId' | 'accountId' | 'via'>;
  resource: string;
  reasonCode: string | null;
  expiresAt?: Date | null;
  /** Labels and hashes only: never arguments, results or credentials. */
  sideEffect: Record<string, unknown>;
}

/**
 * Write one audit row and wait for it. A write-class call is only sent once
 * its attempt row is stored (the deploy precedent): if this throws, the
 * route refuses the call rather than act unrecorded.
 */
export async function writeToolAudit(row: ToolAuditRow): Promise<void> {
  await db.insert(agentCapabilityDecisions).values({
    capability: row.capability,
    decision: row.decision,
    workspaceId: row.principal.workspaceId,
    taskId: row.principal.taskId,
    workerId: row.principal.workerId,
    accountId: row.principal.accountId,
    principalVia: row.principal.via,
    resource: row.resource,
    reasonCode: row.reasonCode,
    expiresAt: row.expiresAt ?? null,
    sideEffect: row.sideEffect,
  });
}

/** Fire-and-forget variant for reads, refusals and results: never blocks or fails the request. */
export function noteToolAudit(row: ToolAuditRow): void {
  void writeToolAudit(row).catch((err: unknown) => {
    console.warn(`[connector-gateway] audit ${row.capability} ${row.decision} not recorded: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown error'}`);
  });
}
