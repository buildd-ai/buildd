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
 * connector's own URL. It is never returned, logged or audited. An assertion
 * connector has no stored credential: the access token is minted and exchanged
 * here (connector-assertion.ts) and held in memory for that worker only. A
 * `none` connector is proxied with no credential at all.
 */
import { db } from '@buildd/core/db';
import {
  accounts,
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
import { refreshMcpConnectorCredential, type McpRefreshResult } from './mcp-connector-refresh';
import { loadPolicyRules } from './capability-grants-store';
import { readRoleCeiling, type CredentialState, type GatewayRun, type ToolAnnotations } from './connector-gateway';
import { snapshotSignature, toolSnapshotOf } from './connector-tool-review';
import { exchangeAssertion, mintConnectorAssertion } from './connector-assertion';
import type { AgentPrincipal } from './agent-capabilities/principal';
import { sqlWhere } from '@buildd/core/db/relational-sql';

type ConnectorRow = typeof connectors.$inferSelect;

export interface LoadedGateway {
  run: GatewayRun;
  connector: Pick<ConnectorRow, 'id' | 'name' | 'url' | 'authMode' | 'headerName' | 'teamId' | 'transport' | 'discoveredMetadata'>
    & Partial<Pick<ConnectorRow, 'assertionAudience' | 'assertionTokenEndpoint'>>;
  secret: { id: string; tokenExpiresAt: Date | null } | null;
  /** Who an assertion is minted for (assertion connectors only): the account that claimed the worker. */
  caller?: { accountId: string; accountTeamId: string | null };
}

/** The auth modes whose credential is a stored `mcp_connector_credential` secret. */
const storedCredential = (authMode: string) => authMode === 'oauth' || authMode === 'header';

/**
 * Can the gateway reach this provider as the connector is configured now?
 * `none` needs nothing; `assertion` needs its exchange config (it mints per
 * call); `oauth`/`header` need a stored credential that is not revoked.
 */
export function credentialStateFor(
  connector: { authMode: string; transport?: string; assertionAudience?: string | null; assertionTokenEndpoint?: string | null },
  secret: { healthStatus?: string | null } | null | undefined,
): CredentialState {
  // A stdio connector runs on the runner: there is nothing here to proxy to.
  if (connector.transport !== undefined && connector.transport !== 'http') return 'missing';
  if (connector.authMode === 'none') return 'ok';
  if (connector.authMode === 'assertion') return connector.assertionAudience && connector.assertionTokenEndpoint ? 'ok' : 'missing';
  if (!secret) return 'missing';
  return secret.healthStatus === 'revoked' ? 'dead' : 'ok';
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
    db.query.connectors.findFirst({ where: sqlWhere(eq(connectors.id, connectorId)) }),
    db.query.tasks.findFirst({
      where: sqlWhere(eq(tasks.id, principal.taskId)),
      columns: { id: true, status: true, roleSlug: true, workspaceId: true, scheduleId: true, missionId: true, createdByUserId: true, parentTaskId: true },
    }),
    db.query.workers.findFirst({ where: sqlWhere(eq(workers.id, principal.workerId)), columns: { status: true } }),
  ]);
  if (!connector) return null;

  const shared = connector.teamId === teamId ? null : await db.query.connectorShares.findFirst({
    where: sqlWhere(and(eq(connectorShares.connectorId, connector.id), eq(connectorShares.sharedWithTeamId, teamId))),
    columns: { connectorId: true },
  });
  const visible = connector.teamId === teamId || !!shared;
  if (!visible) return null;

  const roleSlug = task?.roleSlug ?? null;
  const [cw, block, roleRows, missionRow, secretRow, provider, rules, callerAccount] = await Promise.all([
    db.query.connectorWorkspaces.findFirst({
      where: sqlWhere(and(eq(connectorWorkspaces.connectorId, connector.id), eq(connectorWorkspaces.workspaceId, principal.workspaceId))),
      columns: { enabled: true },
    }),
    checkConnectorBlocked(connector, teamId),
    roleSlug ? db.query.workspaceSkills.findMany({
      where: sqlWhere(and(
        eq(workspaceSkills.slug, roleSlug), eq(workspaceSkills.isRole, true), eq(workspaceSkills.enabled, true),
        eq(workspaceSkills.teamId, teamId),
        or(isNull(workspaceSkills.workspaceId), eq(workspaceSkills.workspaceId, principal.workspaceId)),
      )),
      columns: { ...ROLE_VISIBILITY_COLUMNS, connectorRefs: true, metadata: true },
    }) : Promise.resolve([]),
    task?.missionId ? db.query.missions.findFirst({ where: sqlWhere(eq(missions.id, task.missionId)), columns: { scheduleId: true } }) : Promise.resolve(null),
    storedCredential(connector.authMode) ? db.query.secrets.findFirst({
      where: sqlWhere(teamCredentialWhere({ teamId: connector.teamId, purpose: 'mcp_connector_credential', label: connector.id })),
      columns: { id: true, tokenExpiresAt: true, healthStatus: true },
    }) : Promise.resolve(undefined),
    providerSlugFor(teamId, connector.url),
    loadPolicyRules(teamId),
    connector.authMode === 'assertion' ? db.query.accounts.findFirst({
      where: sqlWhere(eq(accounts.id, principal.accountId)),
      columns: { teamId: true },
    }) : Promise.resolve(undefined),
  ]);

  const role = roleSlug && task
    ? await pickVisibleRoleRowLazy(roleRows, roleSlug, { teamId, workspaceId: principal.workspaceId }, lazyRequester(task))
    : null;
  const refs = ((role as { connectorRefs?: string[] } | null)?.connectorRefs) ?? [];

  const credential = credentialStateFor(connector, secretRow);

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
      assertionAudience: connector.assertionAudience, assertionTokenEndpoint: connector.assertionTokenEndpoint,
    },
    secret: secretRow ? { id: secretRow.id, tokenExpiresAt: secretRow.tokenExpiresAt ?? null } : null,
    ...(connector.authMode === 'assertion' ? { caller: { accountId: principal.accountId, accountTeamId: callerAccount?.teamId ?? null } } : {}),
  };
}

// ── Credential (server-side only) ────────────────────────────────────────────

/** A header the outbound request carries, or `anonymous`: an authMode `none` connector sends none. */
export type ProviderAuth = { name: string; value: string } | { anonymous: true };

/**
 * The auth for the outbound provider request, or null when there is no usable
 * credential. An expired OAuth access token is refreshed first; an assertion
 * connector's token is minted and exchanged (or reused while it lives).
 */
export async function providerAuthHeader(g: LoadedGateway, now: Date = new Date()): Promise<ProviderAuth | null> {
  if (g.connector.authMode === 'none') return { anonymous: true };
  if (g.connector.authMode === 'assertion') return assertionAuthHeader(g, now);
  if (!g.secret) return null;
  if (g.connector.authMode === 'oauth' && g.secret.tokenExpiresAt && g.secret.tokenExpiresAt.getTime() < now.getTime()) {
    const r = await refreshMcpConnectorCredential(g.secret.id);
    if (r !== 'refreshed' && r !== 'locked') return null;
  }
  return storedAuthHeader(g);
}

/** The auth header from the credential as stored now, without refreshing. */
async function storedAuthHeader(g: LoadedGateway): Promise<{ name: string; value: string } | null> {
  if (!g.secret) return null;
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

// ── Assertion tokens (per instance, per worker, short-lived) ─────────────────
// An exchanged token is the worker's own (the assertion's actor is that worker
// on its task), so it is cached per worker and never shared across workers.
// The key also carries the exchange config: an admin edit takes effect at once.

/** Mint again this long before the provider's expiry. */
const ASSERTION_TOKEN_SKEW_MS = 30_000;
const MAX_ASSERTION_TOKENS = 500;
const assertionTokens = new Map<string, { token: string; expiresAt: number }>();

const assertionKey = (g: LoadedGateway) =>
  [g.connector.id, g.run.workerId, g.connector.assertionAudience ?? '', g.connector.assertionTokenEndpoint ?? ''].join('\n');

/** Test-only. */
export function __resetAssertionTokens() { assertionTokens.clear(); }

async function assertionAuthHeader(g: LoadedGateway, now: Date): Promise<ProviderAuth | null> {
  const audience = g.connector.assertionAudience;
  const tokenEndpoint = g.connector.assertionTokenEndpoint;
  if (!audience || !tokenEndpoint || !g.caller) return null;
  const key = assertionKey(g);
  const cached = assertionTokens.get(key);
  if (cached && cached.expiresAt - ASSERTION_TOKEN_SKEW_MS > now.getTime()) {
    return { name: 'Authorization', value: `Bearer ${cached.token}` };
  }
  assertionTokens.delete(key);
  try {
    const minted = await mintConnectorAssertion({
      accountId: g.caller.accountId,
      accountTeamId: g.caller.accountTeamId,
      workerId: g.run.workerId,
      taskId: g.run.taskId,
      audience,
    }, now);
    if (!minted) {
      console.warn(`[connector-gateway] assertion not minted connector=${g.connector.id}: no active signing key`);
      return null;
    }
    const { accessToken, expiresAt } = await exchangeAssertion(tokenEndpoint, minted.assertion);
    assertionTokens.set(key, { token: accessToken, expiresAt });
    if (assertionTokens.size > MAX_ASSERTION_TOKENS) assertionTokens.delete(assertionTokens.keys().next().value!);
    return { name: 'Authorization', value: `Bearer ${accessToken}` };
  } catch (err) {
    // The message carries a status, never the assertion or a token.
    console.warn(`[connector-gateway] assertion exchange failed connector=${g.connector.id}: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`);
    return null;
  }
}

export type RejectionOutcome = McpRefreshResult | 'peer_refreshed' | 'reminted';

/** How long a 401 inside the lock window waits for a peer's refresh to land. */
const PEER_REFRESH_POLLS = 3;
const PEER_REFRESH_POLL_MS = 500;

/**
 * After a provider 401: refresh once (oauth), or drop the exchanged token so the
 * retry mints a fresh one (assertion). `retry` when a retry may succeed.
 *
 * 'locked' means another request refreshed within the lock window, or is
 * refreshing now. If the stored token is no longer the one the provider
 * rejected, that peer's token is retried: the credential is not dead, this
 * request just sent the token the peer replaced.
 */
export async function refreshAfterRejection(
  g: LoadedGateway,
  rejected: ProviderAuth,
  deps: { wait?: (ms: number) => Promise<void> } = {},
): Promise<{ retry: boolean; outcome: RejectionOutcome }> {
  if (g.connector.authMode === 'assertion') {
    assertionTokens.delete(assertionKey(g));
    return { retry: true, outcome: 'reminted' };
  }
  if (!g.secret || g.connector.authMode !== 'oauth' || !('value' in rejected)) return { retry: false, outcome: 'skipped' };
  const r = await refreshMcpConnectorCredential(g.secret.id);
  if (r === 'refreshed') return { retry: true, outcome: r };
  if (r !== 'locked') return { retry: false, outcome: r };
  const wait = deps.wait ?? ((ms: number) => new Promise<void>(res => setTimeout(res, ms)));
  for (let i = 0; i < PEER_REFRESH_POLLS; i++) {
    if (i > 0) await wait(PEER_REFRESH_POLL_MS);
    const current = await storedAuthHeader(g);
    if (current && current.value !== rejected.value) return { retry: true, outcome: 'peer_refreshed' };
  }
  return { retry: false, outcome: 'locked' };
}

/**
 * The provider rejected the credential even after a refresh: mark it the way
 * the runner's mid-task 401 event does, so discovery, the claim pre-filter and
 * the Reconnect banner all see it. The credential row is kept.
 */
export async function markCredentialRejected(g: LoadedGateway): Promise<void> {
  if (!storedCredential(g.connector.authMode)) return; // none/assertion: no stored credential to mark
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
    where: sqlWhere(and(
      eq(agentCapabilityDecisions.workerId, workerId),
      eq(agentCapabilityDecisions.capability, TOOL_CALL_CAPABILITY),
      eq(agentCapabilityDecisions.decision, 'allowed'),
      sql`${agentCapabilityDecisions.sideEffect}->>'callKey' = ${key}`,
    )),
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

// ── Tool snapshot (what Settings › Team › Apps lists) ────────────────────────

const SNAPSHOT_REWRITE_MS = 6 * 60 * 60 * 1000;
/** connector id → the signature last written from this instance, and when. */
const snapshotWrites = new Map<string, { sig: string; at: number }>();

/** Test-only. */
export function __resetSnapshotWrites() { snapshotWrites.clear(); }

/**
 * Keep the tools the provider listed, with only the hints that decide a class
 * (connector-tool-review.ts), on the connector row as
 * `discoveredMetadata.toolSnapshot`. Merged in one statement so an admin's
 * toolPolicy saved at the same moment is never overwritten. Written when the
 * list changed, else at most every few hours per instance. Fire-and-forget:
 * never blocks or fails the request.
 */
export function noteToolSnapshot(connectorId: string, tools: ReadonlyMap<string, ToolAnnotations | null>, now = Date.now()): void {
  const snap = toolSnapshotOf(tools, new Date(now));
  if (!snap) return;
  const sig = snapshotSignature(snap);
  const prev = snapshotWrites.get(connectorId);
  if (prev && prev.sig === sig && now - prev.at < SNAPSHOT_REWRITE_MS) return;
  snapshotWrites.set(connectorId, { sig, at: now });
  if (snapshotWrites.size > 500) snapshotWrites.delete(snapshotWrites.keys().next().value!);
  void db.update(connectors)
    .set({ discoveredMetadata: sql`coalesce(${connectors.discoveredMetadata}, '{}'::jsonb) || jsonb_build_object('toolSnapshot', ${JSON.stringify(snap)}::jsonb)` })
    .where(eq(connectors.id, connectorId))
    .catch((err: unknown) => {
      snapshotWrites.delete(connectorId);
      console.warn(`[connector-gateway] tool snapshot not saved: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown error'}`);
    });
}
