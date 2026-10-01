/**
 * The team's agent model endpoint as Settings → Model providers manages it
 * (storage, precedence and resolution: @buildd/core/agent-endpoint; design:
 * docs/design/agent-model-endpoint.md §4, §6). The key never leaves the
 * server: callers get the base URL, the key's last four characters and health.
 *
 * Rows are team-wide or one workspace, never account- or person-scoped.
 */
import { db } from '@buildd/core/db';
import { secrets, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { decrypt, getSecretsProvider } from '@buildd/core/secrets';
import { maskKeyLast4 } from '@buildd/core/inference-keys';
import type { LookupAll } from '@buildd/core/net/public-address';
import { resolveLiteLLMGateway, type LiteLLMGateway } from '@buildd/core/litellm-gateway';
import { teamCredentialWhere } from '@buildd/core/secrets/team-scope';
import { TIER_DEFAULTS } from '@buildd/core/model-tier-defaults';
import {
  AGENT_ENDPOINT_PURPOSE,
  parseAgentEndpointBlob,
  resolveEndpointFromBlob,
  serializeAgentEndpoint,
  validateAgentEndpointInput,
  verifyAgentEndpoint,
  type AgentEndpointAuthHeader,
  type AgentEndpointBlob,
  type AgentEndpointKind,
  type AgentModelMap,
} from '@buildd/core/agent-endpoint';

export type EndpointHealth = 'healthy' | 'revoked' | 'unknown';

export interface MaskedAgentEndpoint {
  id: string;
  scope: 'team' | 'workspace';
  workspaceId: string | null;
  workspaceName: string | null;
  kind: AgentEndpointKind;
  /** Effective Anthropic-compatible root ('' when a gateway reference has no gateway). */
  baseUrl: string;
  authHeader: AgentEndpointAuthHeader;
  models: AgentModelMap;
  /** Last four characters of the key in use (the gateway's key for `kind: gateway`). */
  last4: string;
  /** `kind: gateway`: whether the referenced gateway currently resolves. */
  gatewayMissing: boolean;
  health: EndpointHealth;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  updatedAt: string;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
/** Test seam: DNS for the verification call's public-address check. */
type VerifyDeps = { fetcher?: Fetcher; lookup?: LookupAll };

/** The model Verify sends: the budget tier, mapped by the endpoint (§4). */
export const VERIFY_MODEL = TIER_DEFAULTS.budget.model;

/** Team-owned endpoint rows: never account- or person-scoped. */
const endpointRows = (teamId: string) =>
  teamCredentialWhere({ teamId, purpose: AGENT_ENDPOINT_PURPOSE }, isNull(secrets.accountId));

function gatewayFor(teamId: string, workspaceId: string | null): Promise<LiteLLMGateway | null> {
  // Same scope or broader: a team-wide reference never picks up a workspace gateway.
  return resolveLiteLLMGateway({ teamId, workspaceId }, { ignoreKeyPolicy: true });
}

function readBlob(encryptedValue: string): AgentEndpointBlob | null {
  try {
    return parseAgentEndpointBlob(decrypt(encryptedValue));
  } catch {
    return null;
  }
}

export async function listTeamAgentEndpoints(teamId: string): Promise<MaskedAgentEndpoint[]> {
  const rows = await db.query.secrets.findMany({
    where: endpointRows(teamId),
    columns: {
      id: true, workspaceId: true, accountId: true, userId: true, purpose: true, encryptedValue: true,
      healthStatus: true, lastVerifiedAt: true, lastVerificationError: true, updatedAt: true,
    },
  });
  const mine = rows.filter((r) => r.purpose === AGENT_ENDPOINT_PURPOSE && !r.accountId && !r.userId);
  const wsIds = [...new Set(mine.map((r) => r.workspaceId).filter((v): v is string => !!v))];
  const names = new Map<string, string>();
  if (wsIds.length > 0) {
    const ws = await db.query.workspaces.findMany({
      where: inArray(workspaces.id, wsIds),
      columns: { id: true, name: true, teamId: true },
    });
    for (const w of ws) if (w.teamId === teamId) names.set(w.id, w.name);
  }

  const out: MaskedAgentEndpoint[] = [];
  for (const r of mine) {
    const blob = readBlob(r.encryptedValue);
    const gateway = blob?.kind === 'gateway' ? await gatewayFor(teamId, r.workspaceId) : null;
    const route = blob ? resolveEndpointFromBlob(blob, gateway) : null;
    out.push({
      id: r.id,
      scope: r.workspaceId ? 'workspace' : 'team',
      workspaceId: r.workspaceId,
      workspaceName: r.workspaceId ? names.get(r.workspaceId) ?? null : null,
      kind: blob?.kind ?? 'anthropic-compatible',
      baseUrl: route?.baseUrl ?? '',
      authHeader: route?.authHeader ?? 'authorization',
      models: blob?.models ?? {},
      last4: route ? maskKeyLast4(route.apiKey) : '',
      gatewayMissing: blob?.kind === 'gateway' && !gateway,
      health: (r.healthStatus as EndpointHealth) ?? 'unknown',
      lastVerifiedAt: r.lastVerifiedAt ? r.lastVerifiedAt.toISOString() : null,
      lastVerificationError: blob ? r.lastVerificationError ?? null : 'stored endpoint could not be read',
      updatedAt: r.updatedAt.toISOString(),
    });
  }
  // Team row first, then workspaces by name.
  return out.sort((a, b) =>
    (a.scope === 'team' ? 0 : 1) - (b.scope === 'team' ? 0 : 1) ||
    (a.workspaceName ?? '').localeCompare(b.workspaceName ?? ''));
}

async function recordHealth(id: string, check: { health: EndpointHealth; error: string | null }): Promise<Date> {
  const now = new Date();
  await db.update(secrets).set({
    healthStatus: check.health,
    lastVerifiedAt: now,
    lastVerificationError: check.error,
    ...(check.health === 'healthy' ? { lastSuccessAt: now } : {}),
    updatedAt: now,
  }).where(eq(secrets.id, id));
  return now;
}

/**
 * Check with one real call, then store. An endpoint that rejects the key is
 * never saved; an outage (`unknown`) is saved and shown as unchecked.
 */
export async function setTeamAgentEndpoint(
  input: { teamId: string; workspaceId?: unknown; endpoint: unknown },
  deps: VerifyDeps = {},
): Promise<{ ok: true; endpoint: MaskedAgentEndpoint } | { ok: false; status: number; error: string }> {
  let workspaceId: string | null = null;
  if (input.workspaceId !== undefined && input.workspaceId !== null && input.workspaceId !== '') {
    if (typeof input.workspaceId !== 'string') return { ok: false, status: 400, error: 'workspaceId must be a workspace id.' };
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, input.workspaceId),
      columns: { id: true, teamId: true, name: true },
    });
    if (!ws || ws.teamId !== input.teamId) return { ok: false, status: 404, error: 'Workspace not found in this team.' };
    workspaceId = ws.id;
  }

  const v = validateAgentEndpointInput(input.endpoint);
  if (!v.ok) return { ok: false, status: 400, error: v.error };

  const gateway = v.blob.kind === 'gateway' ? await gatewayFor(input.teamId, workspaceId) : null;
  if (v.blob.kind === 'gateway' && !gateway) {
    return { ok: false, status: 400, error: 'Connect a LiteLLM gateway first: this option uses its URL and key.' };
  }
  const route = resolveEndpointFromBlob(v.blob, gateway);
  if (!route) return { ok: false, status: 400, error: 'That endpoint routes nothing.' };

  const check = await verifyAgentEndpoint(route, VERIFY_MODEL, { fetcher: deps.fetcher, lookup: deps.lookup });
  if (check.health === 'revoked') {
    return { ok: false, status: 400, error: `The endpoint rejected this key. ${check.error ?? ''}`.trim() };
  }
  if (check.blocked) {
    return { ok: false, status: 400, error: `This endpoint URL can't be used: ${check.error}.` };
  }

  const id = await getSecretsProvider().replaceScoped(serializeAgentEndpoint(v.blob), {
    teamId: input.teamId,
    ...(workspaceId ? { workspaceId } : {}),
    purpose: AGENT_ENDPOINT_PURPOSE,
    userId: null,
  });
  const now = await recordHealth(id, check);

  return {
    ok: true,
    endpoint: {
      id,
      scope: workspaceId ? 'workspace' : 'team',
      workspaceId,
      workspaceName: null,
      kind: route.kind,
      baseUrl: route.baseUrl,
      authHeader: route.authHeader,
      models: route.models,
      last4: maskKeyLast4(route.apiKey),
      gatewayMissing: false,
      health: check.health,
      lastVerifiedAt: now.toISOString(),
      lastVerificationError: check.error,
      updatedAt: now.toISOString(),
    },
  };
}

export async function deleteTeamAgentEndpoint(teamId: string, workspaceId: string | null): Promise<boolean> {
  const deleted = await db.delete(secrets)
    .where(and(endpointRows(teamId), workspaceId ? eq(secrets.workspaceId, workspaceId) : isNull(secrets.workspaceId)))
    .returning({ id: secrets.id });
  return deleted.length > 0;
}

/**
 * POST /api/secrets/[id]/verify for an `agent_endpoint` row: one Messages call
 * through the endpoint, recorded on the row's health columns.
 */
export async function verifyAgentEndpointSecret(
  secretId: string,
  deps: VerifyDeps = {},
): Promise<{ health: EndpointHealth; error: string | null }> {
  const row = await db.query.secrets.findFirst({
    where: eq(secrets.id, secretId),
    columns: { id: true, teamId: true, workspaceId: true, purpose: true, encryptedValue: true },
  });
  if (!row || row.purpose !== AGENT_ENDPOINT_PURPOSE) return { health: 'unknown', error: 'Not an agent endpoint.' };
  const blob = readBlob(row.encryptedValue);
  const gateway = blob?.kind === 'gateway' ? await gatewayFor(row.teamId, row.workspaceId) : null;
  const route = blob ? resolveEndpointFromBlob(blob, gateway) : null;
  const check = route
    ? await verifyAgentEndpoint(route, VERIFY_MODEL, { fetcher: deps.fetcher, lookup: deps.lookup })
    : { health: 'unknown' as const, error: blob ? 'The team gateway this endpoint uses is not connected.' : 'Stored endpoint could not be read.' };
  await recordHealth(row.id, check);
  return { health: check.health, error: check.error };
}
