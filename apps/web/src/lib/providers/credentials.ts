/**
 * Provider credentials as `/api/providers` and MCP `manage_providers` see
 * them: every registry provider, what it serves, which rows are set at each
 * scope, and set/delete per (provider, shape, scope) through the one write
 * path (./write-path).
 *
 * Values never leave this module: a row is summarised by its last four
 * characters, health and where it is stored. Authorization is the caller's
 * job (the route checks the permission `planProviderWrite` names).
 */
import { db } from '@buildd/core/db';
import { secrets, teams, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { decrypt } from '@buildd/core/secrets';
import { policyColumns } from '@buildd/core/inference-key-policy';
import {
  PROVIDER_REGISTRY,
  SURFACES,
  isCredentialPolicy,
  providerDescriptor,
  surfacePolicy,
  type CredentialPolicy,
  type CredentialShape,
  type CredentialStorage,
  type ProviderDescriptor,
  type ProviderId,
  type Surface,
} from '@buildd/core/providers';
import {
  CONNECT_IN_BROWSER,
  PROVIDERS_SETTINGS_PATH,
  PROVIDER_API_SCOPES,
  PROVIDER_SCOPE_UNSUPPORTED,
  PROVIDER_SURFACE_UNSUPPORTED,
  modelCredentialPurposes,
  providerShape,
  rowProvider,
  scopeRefusal,
  servedSurfaces,
  shapeWritesTo,
  storageServes,
  surfaceRefusal,
  writePermissions,
  writeStorage,
  type ProviderApiScope,
  type ShapeId,
  type WritePermission,
} from '@buildd/core/providers/manage';
import type {
  ChatProvider,
  ProviderCredentialSummary,
  ProviderListing,
  ProviderPolicySummary,
  ProviderRefusal,
  ProviderShapeListing,
} from '@buildd/shared';
import {
  removeAgentEndpoint,
  removeChatKey,
  removeGateway,
  requeueAfterAgentCredential,
  sanitizeKey,
  sharedKeyPrefixRefusal,
  verifyApiKey,
  writeAgentEndpoint,
  writeChatKey,
  writeGateway,
  writeSharedSecret,
  writeTeamChatKey,
} from './write-path';

// ── Rows ─────────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  teamId: string;
  purpose: string;
  label: string | null;
  encryptedValue: string;
  accountId: string | null;
  workspaceId: string | null;
  userId: string | null;
  healthStatus: string | null;
  lastVerifiedAt: Date | null;
  lastVerificationError: string | null;
  updatedAt: Date | null;
}

const ROW_COLUMNS = {
  id: true, teamId: true, purpose: true, label: true, encryptedValue: true, accountId: true, workspaceId: true, userId: true,
  healthStatus: true, lastVerifiedAt: true, lastVerificationError: true, updatedAt: true,
} as const;

/** Endpoint kind → the provider whose card the row belongs on. */
const ENDPOINT_KIND_PROVIDER: Record<string, ProviderId> = {
  gateway: 'litellm',
  openrouter: 'openrouter',
  'anthropic-compatible': 'custom-endpoint',
};

const REFRESH_FAMILIES = new Set(['claude_credential', 'codex_credential']);

/** Last four characters, or '' for anything too short to be a key (as every masked key in Settings). */
function maskKeyLast4(value: string): string {
  const v = value.trim();
  return v.length >= 8 ? v.slice(-4) : '';
}

/**
 * Team rows (and, when given, one workspace's and one person's own) of every
 * model-credential purpose. Another member's personal row is never read.
 */
async function loadRows(teamId: string, workspaceId: string | null, userId: string | null): Promise<Row[]> {
  const purposes = modelCredentialPurposes();
  const rows = (await db.query.secrets.findMany({
    where: and(
      eq(secrets.teamId, teamId),
      inArray(secrets.purpose, modelCredentialPurposes() as never[]),
      workspaceId ? or(isNull(secrets.workspaceId), eq(secrets.workspaceId, workspaceId)) : isNull(secrets.workspaceId),
      userId ? or(isNull(secrets.userId), eq(secrets.userId, userId)) : isNull(secrets.userId),
    ),
    columns: ROW_COLUMNS,
  })) as Row[];
  // Every predicate again in JS: a personal row reaches only its owner.
  return rows.filter(r =>
    r.teamId === teamId &&
    purposes.includes(r.purpose) &&
    (r.workspaceId === null || r.workspaceId === workspaceId) &&
    (r.userId === null || (userId !== null && r.userId === userId)));
}

interface Classified { provider: ProviderId; shape: ShapeId; storage: CredentialStorage; legacy: boolean; endpointKind?: string; key: string | null }

function decryptOrNull(row: Row): string | null {
  try { return decrypt(row.encryptedValue) ?? null; } catch { return null; }
}

function jsonField(value: string | null, field: string): string | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value) as Record<string, unknown>;
    return typeof v?.[field] === 'string' ? v[field] as string : null;
  } catch {
    return null;
  }
}

/** Which provider a row belongs to, and the key whose last four are shown (never returned whole). */
function classify(row: Row): Classified | null {
  const value = decryptOrNull(row);
  if (row.purpose === 'agent_endpoint') {
    const kind = jsonField(value, 'kind');
    const provider = (kind && ENDPOINT_KIND_PROVIDER[kind]) || 'custom-endpoint';
    const storage = providerDescriptor('custom-endpoint').shapes[0].storage;
    return { provider, shape: 'endpoint', storage, legacy: false, endpointKind: kind ?? undefined, key: jsonField(value, 'apiKey') };
  }
  const match = rowProvider(row);
  if (!match) return null;
  const shape = providerDescriptor(match.provider).shapes.find(s => s.id === match.shape)!;
  const storage = [shape.storage, ...shape.legacy].find(s =>
    s.purpose === row.purpose && (s.label === undefined || s.label === (row.label ?? '').toLowerCase()))!;
  const key = REFRESH_FAMILIES.has(row.purpose)
    ? null
    : shape.id === 'gateway' ? jsonField(value, 'apiKey') : value;
  return { ...match, storage, key };
}

function rowScope(row: Row): ProviderApiScope {
  return row.userId ? 'mine' : row.workspaceId ? 'workspace' : 'team';
}

function summarize(row: Row, c: Classified): ProviderCredentialSummary {
  const p = providerDescriptor(c.provider);
  const servesToday: Surface[] = row.purpose === 'agent_endpoint'
    ? servedSurfaces(p).filter(s => s !== 'chat')
    : row.userId
      // A personal row is read only by the resolver, on every surface it serves.
      ? servedSurfaces(p)
      : storageServes(p, c.storage);
  return {
    id: row.id,
    provider: c.provider,
    shape: c.shape,
    scope: rowScope(row),
    workspaceId: row.workspaceId,
    accountScoped: !!row.accountId,
    purpose: row.purpose,
    label: row.label,
    legacy: c.legacy,
    ...(c.endpointKind ? { endpointKind: c.endpointKind } : {}),
    last4: REFRESH_FAMILIES.has(row.purpose) ? null : maskKeyLast4(c.key ?? ''),
    health: row.healthStatus ?? 'unknown',
    lastVerifiedAt: row.lastVerifiedAt ? row.lastVerifiedAt.toISOString() : null,
    lastVerificationError: row.lastVerificationError ?? null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
    servesToday,
  };
}

function summarizeAll(rows: Row[]): ProviderCredentialSummary[] {
  const out: ProviderCredentialSummary[] = [];
  for (const row of rows) {
    const c = classify(row);
    if (c) out.push(summarize(row, c));
  }
  return out;
}

// ── Listing ──────────────────────────────────────────────────────────────────

function shapeListing(p: ProviderDescriptor, shape: CredentialShape): ProviderShapeListing {
  return { id: shape.id, refreshes: shape.refreshes, connectInBrowser: shape.id === 'oauth_managed', writesTo: shapeWritesTo(p.id, shape) };
}

export function providerListing(
  p: ProviderDescriptor,
  set: ProviderListing['set'],
): ProviderListing {
  const scopes = {} as ProviderListing['scopes'];
  for (const scope of PROVIDER_API_SCOPES) {
    const reason = scopeRefusal(p.id, scope);
    scopes[scope] = reason ? { ok: false, reason } : { ok: true };
  }
  const surfaces = {} as ProviderListing['surfaces'];
  for (const s of SURFACES) surfaces[s] = p.surfaces[s];
  return {
    id: p.id,
    label: p.label,
    order: p.settingsCard.order,
    connectFlow: p.settingsCard.connectFlow,
    surfaces,
    scopes,
    shapes: p.shapes.map(s => shapeListing(p, s)),
    set,
  };
}

export async function loadPolicySummary(teamId: string): Promise<ProviderPolicySummary> {
  let team: { credentialPolicy: unknown; inferenceKeyPolicy: unknown } | null = null;
  try {
    team = (await db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      columns: { credentialPolicy: true, inferenceKeyPolicy: true },
    })) ?? null;
  } catch (error) {
    console.warn('[providers] policy lookup failed:', error);
  }
  const chat = surfacePolicy(team, 'chat');
  const agent = surfacePolicy(team, 'agent-claude');
  return {
    credentialPolicy: isCredentialPolicy(team?.credentialPolicy) ? team!.credentialPolicy as CredentialPolicy : null,
    chat: { policy: chat.policy, source: chat.source },
    agent: { policy: agent.policy, enforced: agent.enforced, source: agent.source },
  };
}

/**
 * Every provider, in Settings order, with its rows per scope. `userId` is the
 * signed-in person (their own rows fill `mine`); null for a key or task token.
 */
export async function listProviders(input: { teamId: string; workspaceId: string | null; userId: string | null }): Promise<ProviderListing[]> {
  const rows = await loadRows(input.teamId, input.workspaceId, input.userId);
  const summaries = summarizeAll(rows);
  return [...PROVIDER_REGISTRY]
    .sort((a, b) => a.settingsCard.order - b.settingsCard.order)
    .map(p => {
      const mineRows = summaries.filter(s => s.provider === p.id);
      return providerListing(p, {
        team: mineRows.filter(s => s.scope === 'team'),
        workspace: input.workspaceId ? mineRows.filter(s => s.scope === 'workspace' && s.workspaceId === input.workspaceId) : null,
        mine: input.userId ? mineRows.filter(s => s.scope === 'mine') : null,
      });
    });
}

/** Rows of one provider at exactly one scope (after a write). */
async function credentialsAt(teamId: string, provider: ProviderId, scope: ProviderApiScope, workspaceId: string | null, userId: string | null) {
  const rows = await loadRows(teamId, scope === 'workspace' ? workspaceId : null, scope === 'mine' ? userId : null);
  return summarizeAll(rows).filter(s =>
    s.provider === provider && s.scope === scope && (scope !== 'workspace' || s.workspaceId === workspaceId));
}

// ── Planning a write ─────────────────────────────────────────────────────────

export type Refusal = { status: number; body: ProviderRefusal | { error: string } };

export interface WritePlan {
  provider: ProviderId;
  shape: CredentialShape;
  scope: ProviderApiScope;
  /** Where a set lands. */
  storage: CredentialStorage;
  /** Team/workspace: what the caller must hold (a delete may touch several storages). Empty for `mine`. */
  permissions: WritePermission[];
}

/**
 * Validate (provider, shape, scope[, surface]) against the registry. Refusals
 * carry the registry's own strings.
 */
export function planProviderWrite(input: {
  provider: ProviderId;
  shape?: ShapeId;
  scope: ProviderApiScope;
  surface?: Surface;
  op: 'set' | 'delete';
}): { ok: true; plan: WritePlan } | { ok: false; refusal: Refusal } {
  const p = providerDescriptor(input.provider);
  if (input.surface) {
    const no = surfaceRefusal(input.provider, input.surface);
    if (no) {
      return { ok: false, refusal: { status: 422, body: { error: PROVIDER_SURFACE_UNSUPPORTED, provider: p.id, surface: input.surface, reason: no.reason, ...(no.instead ? { instead: no.instead } : {}) } } };
    }
  }
  const shape = providerShape(input.provider, input.shape);
  if (!shape) {
    return { ok: false, refusal: { status: 400, body: { error: `${p.label} has no ${input.shape} credential. Its shapes: ${p.shapes.map(s => s.id).join(', ')}.` } } };
  }
  const scopeNo = scopeRefusal(input.provider, input.scope);
  if (scopeNo && input.op === 'set') {
    return { ok: false, refusal: { status: 422, body: { error: PROVIDER_SCOPE_UNSUPPORTED, provider: p.id, scope: input.scope, reason: scopeNo } } };
  }
  if (shape.id === 'oauth_managed' && input.op === 'set') {
    return {
      ok: false,
      refusal: {
        status: 422,
        body: {
          error: CONNECT_IN_BROWSER, provider: p.id, scope: input.scope,
          reason: `${p.label} is connected by signing in, in the browser; a token is never pasted over the API.`,
          url: PROVIDERS_SETTINGS_PATH,
        },
      },
    };
  }
  const storage = writeStorage(input.provider, shape, input.scope);
  const permissions = input.scope === 'mine'
    ? []
    : [...new Set(input.op === 'set'
        ? writePermissions(shape, storage)
        : [shape.storage, ...shape.legacy].flatMap(st => writePermissions(shape, st)))];
  return { ok: true, plan: { provider: input.provider, shape, scope: input.scope, storage, permissions } };
}

// ── Set ──────────────────────────────────────────────────────────────────────

export type WriteResult =
  | { ok: true; credentials: ProviderCredentialSummary[]; requeued?: number }
  | { ok: false; status: number; error: string };

/** Route (chat key provider) of an API-key provider. */
function chatProviderOf(provider: ProviderId): ChatProvider | null {
  const route = providerDescriptor(provider).route;
  return route === 'anthropic' || route === 'openai' || route === 'openrouter' ? route : null;
}

async function workspaceInTeam(teamId: string, workspaceId: string): Promise<boolean> {
  const ws = await db.query.workspaces.findFirst({
    where: and(eq(workspaces.id, workspaceId), eq(workspaces.teamId, teamId)),
    columns: { id: true },
  });
  return !!ws;
}

/** A shared API key or setup token, at team or workspace scope, in a storage other than the chat key's own. */
async function writeSharedKey(input: {
  teamId: string; workspaceId: string | null; provider: ProviderId; storage: CredentialStorage; value: string;
}): Promise<{ ok: true; requeued: number } | { ok: false; status: number; error: string }> {
  const value = sanitizeKey(input.value);
  if (!value || /\s/.test(value)) return { ok: false, status: 400, error: 'That doesn\'t look like a key.' };
  const prefixRefusal = sharedKeyPrefixRefusal(input.storage.purpose, input.storage.label, value);
  if (prefixRefusal) return { ok: false, status: 400, error: prefixRefusal };

  // API keys are checked with the provider before they are stored, like the chat key form.
  const chat = chatProviderOf(input.provider);
  let check: { health: 'healthy' | 'revoked' | 'unknown'; error: string | null } | null = null;
  if (chat) {
    const { providerKeyProblem } = await import('@/lib/provider-keys');
    const problem = providerKeyProblem(chat, value);
    if (problem) return { ok: false, status: 400, error: problem };
    check = await verifyApiKey(chat, value);
    if (check.health === 'revoked') return { ok: false, status: 400, error: `The provider rejected this key. ${check.error ?? ''}`.trim() };
  }

  const id = await writeSharedSecret({
    teamId: input.teamId,
    accountId: undefined,
    workspaceId: input.workspaceId ?? undefined,
    purpose: input.storage.purpose,
    label: input.storage.label ?? undefined,
    value,
  });
  if (check) {
    const now = new Date();
    await db.update(secrets).set({
      healthStatus: check.health,
      lastVerifiedAt: now,
      lastVerificationError: check.error,
      ...(check.health === 'healthy' ? { lastSuccessAt: now } : {}),
      updatedAt: now,
    }).where(eq(secrets.id, id));
  }
  return { ok: true, requeued: await requeueAfterAgentCredential(input.teamId, input.storage.purpose, input.storage.label) };
}

/** Store a credential per a plan. The caller has authorized it. */
export async function setProviderCredential(input: {
  plan: WritePlan;
  teamId: string;
  workspaceId: string | null;
  /** The signed-in person; required for `mine`. */
  userId: string | null;
  value?: unknown;
  config?: Record<string, unknown>;
}): Promise<WriteResult> {
  const { plan, teamId } = input;
  const workspaceId = plan.scope === 'workspace' ? input.workspaceId : null;
  if (plan.scope === 'workspace') {
    if (!workspaceId) return { ok: false, status: 400, error: 'workspaceId is required with scope workspace' };
    if (!(await workspaceInTeam(teamId, workspaceId))) return { ok: false, status: 404, error: 'Workspace not found' };
  }
  if (plan.scope === 'mine' && !input.userId) return { ok: false, status: 403, error: 'A personal credential belongs to a signed-in person.' };
  const value = typeof input.value === 'string' ? input.value : undefined;
  const config = input.config ?? {};

  let requeued: number | undefined;
  switch (plan.shape.id) {
    case 'api_key':
    case 'setup_token': {
      if (!value || !value.trim()) return { ok: false, status: 400, error: 'value is required' };
      const chat = chatProviderOf(plan.provider);
      const chatKey = chat && plan.storage.purpose === 'inference_key' && plan.storage.label === chat && !workspaceId;
      if (chatKey && plan.scope === 'team') {
        // The team chat key, by the same function /api/inference-keys uses:
        // prefix check for a key agent runs read, verify-before-store, re-queue.
        const r = await writeTeamChatKey({ teamId, userId: input.userId ?? '', provider: chat!, value });
        if (!r.ok) return r;
        requeued = r.requeued;
      } else if (chatKey) {
        // A personal chat key: the chat key's own function, with its policy check.
        const r = await writeChatKey({ teamId, userId: input.userId ?? '', provider: chat!, scope: 'user', value });
        if (!r.ok) return r;
      } else {
        const r = await writeSharedKey({ teamId, workspaceId, provider: plan.provider, storage: plan.storage, value });
        if (!r.ok) return r;
        requeued = r.requeued;
      }
      break;
    }
    case 'gateway': {
      if (workspaceId) return { ok: false, status: 400, error: 'A LiteLLM gateway is set team-wide; omit workspaceId.' };
      const r = await writeGateway({ teamId, baseUrl: config.baseUrl, apiKey: value });
      if (!r.ok) return r;
      break;
    }
    case 'endpoint': {
      const endpoint = { kind: 'anthropic-compatible', ...config, ...(value !== undefined ? { apiKey: value } : {}) };
      const r = await writeAgentEndpoint({ teamId, workspaceId: workspaceId ?? undefined, endpoint });
      if (!r.ok) return r;
      break;
    }
    default:
      return { ok: false, status: 422, error: `${plan.shape.id} is connected in the browser.` };
  }
  return {
    ok: true,
    credentials: await credentialsAt(teamId, plan.provider, plan.scope, workspaceId, input.userId),
    ...(requeued !== undefined ? { requeued } : {}),
  };
}

// ── Delete ───────────────────────────────────────────────────────────────────

/** Remove the provider's rows (canonical and legacy) at exactly one scope. */
export async function deleteProviderCredential(input: {
  plan: WritePlan;
  teamId: string;
  workspaceId: string | null;
  userId: string | null;
}): Promise<{ ok: true; deleted: number; credentials: ProviderCredentialSummary[] } | { ok: false; status: number; error: string }> {
  const { plan, teamId } = input;
  const workspaceId = plan.scope === 'workspace' ? input.workspaceId : null;
  if (plan.scope === 'workspace' && !workspaceId) return { ok: false, status: 400, error: 'workspaceId is required with scope workspace' };
  if (plan.scope === 'mine' && !input.userId) return { ok: false, status: 403, error: 'A personal credential belongs to a signed-in person.' };

  let deleted = 0;
  if (plan.shape.id === 'endpoint') {
    deleted = (await removeAgentEndpoint(teamId, workspaceId)) ? 1 : 0;
  } else if (plan.shape.id === 'gateway' && plan.scope === 'team') {
    deleted = (await removeGateway(teamId)) ? 1 : 0;
  } else if (plan.scope === 'mine' && plan.shape.id === 'api_key' && chatProviderOf(plan.provider)) {
    deleted = (await removeChatKey({ teamId, userId: input.userId!, provider: chatProviderOf(plan.provider)!, scope: 'user' })) ? 1 : 0;
  } else {
    const storages = plan.scope === 'mine' ? [plan.shape.storage] : [plan.shape.storage, ...plan.shape.legacy];
    const rows = await db.delete(secrets).where(and(
      eq(secrets.teamId, teamId),
      or(...storages.map(st => st.label
        ? and(eq(secrets.purpose, st.purpose as never), eq(secrets.label, st.label))
        : eq(secrets.purpose, st.purpose as never))),
      workspaceId ? eq(secrets.workspaceId, workspaceId) : isNull(secrets.workspaceId),
      isNull(secrets.accountId),
      plan.scope === 'mine' ? eq(secrets.userId, input.userId!) : isNull(secrets.userId),
    )).returning({ id: secrets.id });
    deleted = rows.length;
  }
  return { ok: true, deleted, credentials: await credentialsAt(teamId, plan.provider, plan.scope, workspaceId, input.userId) };
}

// ── Policy ───────────────────────────────────────────────────────────────────

export async function setCredentialPolicy(teamId: string, policy: CredentialPolicy): Promise<ProviderPolicySummary> {
  await db.update(teams).set({ ...policyColumns(policy), updatedAt: new Date() }).where(eq(teams.id, teamId));
  return loadPolicySummary(teamId);
}
