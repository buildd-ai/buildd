/**
 * One resolver for every provider and every surface. Chat and inference keys
 * (`../inference-keys`) and the LiteLLM gateway (`../litellm-gateway`) resolve
 * through it; the host claim path and cloud egress move onto it in later slices.
 *
 *   resolveProviderCredential({ teamId, workspaceId, accountId, requesterUserId, surface, provider? })
 *     → { credential, provider, scope, source, why } | { none: true, reason, why }
 *
 * ## Algorithm
 *
 * 1. **Eligible providers**: registry providers whose `surfaces[surface].ok`,
 *    narrowed and ordered by `provider` / `providers` when given. The rest are
 *    listed in `why` with the registry's reason.
 * 2. **One query** over `secrets` for the team (`providerCredentialWhere`):
 *    every canonical and legacy storage of those providers, plus
 *    `agent_endpoint` on agent surfaces; rows of this workspace or none; rows of
 *    this account or none; and a personal row only when it is the requester's
 *    and the policy can use one. Every predicate is re-checked in JS.
 * 3. **Policy** (`./policy`) drops scopes the team's policy forbids, and the
 *    requester rule (`./requester`) drops anyone else's personal row.
 * 4. **Rank**, most specific scope first:
 *    - agent surfaces: personal > workspace > account > team. A revoked row
 *      never shadows a live one (it is a last resort, as
 *      `pickMostSpecificCredential` has it); a dead refresh family
 *      (`claude_credential` with no expiry, or any revoked refresh family) and a
 *      revoked endpoint are dropped. Within a scope an `agent_endpoint` row
 *      precedes direct keys and seats (the endpoint wins a tie), then provider
 *      order, then canonical over legacy storage, then newest.
 *    - chat: personal > account > workspace > team > an account-scoped row for
 *      a caller with no account (legacy), then the provider env var outside
 *      production. Within a scope: provider order, canonical over legacy,
 *      healthy over revoked, newest — exactly `resolveInferenceCredential`.
 * 5. **Decrypt the first viable row**; a decrypt failure, an unparseable or
 *    inapplicable endpoint is recorded in `why` and the next row tried.
 *
 * With the defaults (agent surface, `credentialPolicy` NULL, or chat with its
 * own inputs) the outcome is what the per-surface resolvers pick today; the
 * parity tables in `__tests__/provider-resolve.test.ts` hold it there.
 *
 * ## What it returns
 *
 * The stored row's decrypted value, unparsed except for an endpoint blob
 * (needed to tell which provider the endpoint routes to). Building the wire
 * route from it (a gateway reference's gateway, a seat's access token) stays
 * with the callers. `why` names scopes, providers and storages, never a value.
 *
 * `litellm` is never a direct agent credential: agents reach a gateway only
 * through an `agent_endpoint` row of kind `gateway`, which references it.
 *
 * Pure ranking (`selectProviderCredential`) is separate from the query, so it
 * is table-tested without a database; the SQL is tested against real Postgres
 * in `apps/web/tests/db/provider-resolve.test.ts`.
 */
// Only and/eq/or/isNull/sql from drizzle, and nothing that imports more: the
// chat and inference wrappers load this module under test stubs of exactly
// that set (inference-client, decision-client tests).
import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { secrets } from '../db/schema';
import { ROUTES } from '@builddai/ai-kit/models/routes';
import { endpointAppliesTo, parseAgentEndpointBlob, type AgentEndpointBlob, type AgentEndpointKind } from '../agent-endpoint';
import {
  PROVIDER_REGISTRY,
  providerDescriptor,
  type CredentialShape,
  type CredentialStorage,
  type ModelCredentialPurpose,
  type ProviderDescriptor,
  type ProviderId,
  type Surface,
} from './registry';
import {
  NO_PERSONAL_CREDENTIAL,
  appliedPolicy,
  isAgentSurface,
  policyAllowsScope,
  policyScopeReason,
  surfacePolicy,
  type PolicyScope,
  type SurfacePolicy,
  type TeamPolicyColumns,
} from './policy';
import { normalizeRequester, personalRowEligible } from './requester';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ResolveProviderCredentialInput {
  teamId: string;
  workspaceId: string | null;
  /** The API-key account making the call (runner claim, decision call); null for a person in chat. */
  accountId: string | null;
  /** The person the work is for (chat's user, or `resolveTaskRequesterUserId`). Null = team work. */
  requesterUserId: string | null;
  surface: Surface;
  /** Only this provider. */
  provider?: ProviderId;
  /** Ordered provider preference (e.g. from the tier). Narrows and orders; never widens. */
  providers?: readonly ProviderId[];
  /** The team's policy columns, when the caller already has the row. Loaded otherwise. */
  team?: TeamPolicyColumns | null;
  /**
   * Only these `secrets.purpose` values, in this preference order within a
   * scope (it replaces canonical-before-legacy). Narrows; never widens.
   */
  purposes?: readonly string[];
  /** Only these scopes (a gateway: workspace and team). Narrows the policy; never widens it. */
  scopes?: readonly PolicyScope[];
  /** Is a decrypted value usable? One that is not is skipped, and the next row tried. */
  accept?: (value: string) => boolean;
  /** Decrypt with the caller's secrets module. Defaults to `../secrets/crypto`. */
  decrypt?: (encrypted: string) => string;
}

export interface ResolvedProviderCredential {
  provider: ProviderId;
  shape: CredentialShape['id'];
  /** Decrypted stored value (a key, a token, or a JSON blob). Never logged. */
  value: string;
  /** Parsed endpoint blob, when the row is an `agent_endpoint`. */
  endpoint?: AgentEndpointBlob;
  tokenExpiresAt: Date | null;
}

export interface CredentialSource {
  scope: PolicyScope;
  /** Null for env. */
  secretId: string | null;
  purpose: ModelCredentialPurpose | null;
  label: string | null;
  /** Matched a legacy alias, not the provider's canonical storage. */
  legacy: boolean;
  /** Env var name, for `scope: 'env'`. */
  envVar?: string;
}

export type ProviderCredentialResult =
  | {
      none?: undefined;
      credential: ResolvedProviderCredential;
      provider: ProviderId;
      scope: PolicyScope;
      source: CredentialSource;
      why: string[];
    }
  | {
      none: true;
      /** `no_personal_credential`: the policy needs a requester's own credential and there is none to use. */
      reason: 'no_credential' | typeof NO_PERSONAL_CREDENTIAL;
      credential?: undefined;
      provider?: undefined;
      scope?: undefined;
      source?: undefined;
      why: string[];
    };

/** The `secrets` columns the resolver reads. */
export interface ProviderCredentialRow {
  id: string;
  purpose: string;
  label: string | null;
  encryptedValue: string;
  accountId: string | null;
  workspaceId: string | null;
  userId: string | null;
  healthStatus: string | null;
  tokenExpiresAt: Date | null;
  updatedAt: Date | null;
}

// ── Eligible providers ───────────────────────────────────────────────────────

const ENDPOINT_PURPOSE = 'agent_endpoint' as const;
const REFRESH_FAMILIES: readonly string[] = ['claude_credential', 'codex_credential'];

/** Provider an endpoint blob routes to. */
const ENDPOINT_KIND_PROVIDER: Readonly<Record<AgentEndpointKind, ProviderId>> = {
  gateway: 'litellm',
  openrouter: 'openrouter',
  'anthropic-compatible': 'custom-endpoint',
  // A routing preference over the team's own Anthropic or OpenRouter key.
  cloudflare: 'custom-endpoint',
};
const ENDPOINT_PROVIDERS: readonly ProviderId[] = ['litellm', 'openrouter', 'custom-endpoint'];

export interface EligibleProviders {
  /** In preference order. */
  eligible: ProviderId[];
  /** Asked for (or in the registry) but impossible on this surface, with the registry's reason. */
  impossible: Array<{ provider: ProviderId; reason: string }>;
}

export function eligibleProviders(surface: Surface, preference?: readonly ProviderId[]): EligibleProviders {
  const order = preference && preference.length > 0
    ? [...new Set(preference)]
    : PROVIDER_REGISTRY.map(p => p.id);
  const eligible: ProviderId[] = [];
  const impossible: EligibleProviders['impossible'] = [];
  for (const id of order) {
    const support = providerDescriptor(id).surfaces[surface];
    if (support.ok) eligible.push(id);
    else impossible.push({ provider: id, reason: support.reason });
  }
  return { eligible, impossible };
}

/** May this provider's credential sit in the personal scope, and is that delivered yet? */
export function personalScopeDelivered(p: ProviderDescriptor): boolean {
  return p.scopes.includes('personal') && !(p.pendingScopes ?? []).includes('personal');
}

interface StorageMatch {
  provider: ProviderId;
  shape: CredentialShape['id'];
  storage: CredentialStorage;
  legacy: boolean;
  /** Index in the eligible list. */
  providerIndex: number;
  /** 0 = canonical; legacy aliases follow. */
  storageIndex: number;
}

/**
 * Storages the resolver reads on a surface, in preference order. On agent
 * surfaces a direct `litellm` row is skipped (gateways reach agents only via
 * an endpoint reference), and `agent_endpoint` is read whenever a provider an
 * endpoint can route to is eligible.
 */
function storagesFor(surface: Surface, eligible: readonly ProviderId[], purposes?: readonly string[]): StorageMatch[] {
  const out: StorageMatch[] = [];
  eligible.forEach((id, providerIndex) => {
    if (isAgentSurface(surface) && id === 'litellm') return;
    let storageIndex = 0;
    for (const shape of providerDescriptor(id).shapes) {
      for (const [i, storage] of [shape.storage, ...shape.legacy].entries()) {
        if (storage.purpose === ENDPOINT_PURPOSE) continue; // added below
        if (purposes && !purposes.includes(storage.purpose)) continue;
        out.push({ provider: id, shape: shape.id, storage, legacy: i > 0, providerIndex, storageIndex: storageIndex++ });
      }
    }
  });
  // A caller's purpose order replaces canonical-before-legacy within a provider.
  if (purposes) for (const s of out) s.storageIndex = purposes.indexOf(s.storage.purpose);
  return out;
}

function readsEndpoints(surface: Surface, eligible: readonly ProviderId[], purposes?: readonly string[]): boolean {
  return isAgentSurface(surface) && eligible.some(p => ENDPOINT_PROVIDERS.includes(p)) &&
    (!purposes || purposes.includes(ENDPOINT_PURPOSE));
}

/** The `secrets.purpose` values one resolve reads (narrowed by `purposes` when given). */
export function resolvePurposes(surface: Surface, eligible: readonly ProviderId[], purposes?: readonly string[]): ModelCredentialPurpose[] {
  const out = new Set<ModelCredentialPurpose>(storagesFor(surface, eligible, purposes).map(s => s.storage.purpose));
  if (readsEndpoints(surface, eligible, purposes)) out.add(ENDPOINT_PURPOSE);
  return [...out];
}

// ── SQL predicate ────────────────────────────────────────────────────────────

export interface ProviderCredentialWhereInput {
  teamId: string;
  workspaceId: string | null;
  accountId: string | null;
  requesterUserId: string | null;
  purposes: readonly string[];
  /** Can the policy use a personal row at all? False ⇒ `user_id IS NULL`. */
  personalAllowed: boolean;
  /**
   * Chat reads an account-scoped row for a caller with no account (legacy);
   * agent surfaces never read another account's row.
   */
  legacyAccountRows: boolean;
}

/**
 * The one query's WHERE. Personal rows are reachable only through
 * `user_id = requester`, and only when the policy allows one; with no
 * requester the branch is `false`, so no personal row can come back.
 */
export function providerCredentialWhere(input: ProviderCredentialWhereInput): SQL {
  const requester = normalizeRequester(input.requesterUserId);
  const conds: (SQL | undefined)[] = [
    eq(secrets.teamId, input.teamId),
    input.purposes.length > 0 ? or(...input.purposes.map(p => eq(secrets.purpose, p as never))) : sql`false`,
    or(isNull(secrets.workspaceId), input.workspaceId ? eq(secrets.workspaceId, input.workspaceId) : sql`false`),
    or(isNull(secrets.userId), input.personalAllowed && requester ? eq(secrets.userId, requester) : sql`false`),
  ];
  if (input.accountId) conds.push(or(isNull(secrets.accountId), eq(secrets.accountId, input.accountId)));
  else if (!input.legacyAccountRows) conds.push(isNull(secrets.accountId));
  return and(...conds)!;
}

// ── Pure selection ───────────────────────────────────────────────────────────

export interface SelectContext {
  workspaceId: string | null;
  accountId: string | null;
  requesterUserId: string | null;
  surface: Surface;
  /** Ordered eligible providers (`eligibleProviders(...).eligible`). */
  eligible: readonly ProviderId[];
  policy: SurfacePolicy;
  /** Provider env vars, and whether they may stand in (chat only, non-production). */
  env?: { allowed: boolean; values: Readonly<Record<string, string | undefined>> };
  /** See `ResolveProviderCredentialInput`. */
  purposes?: readonly string[];
  scopes?: readonly PolicyScope[];
  accept?: (value: string) => boolean;
}

interface Candidate {
  row: ProviderCredentialRow;
  match: StorageMatch | null; // null ⇒ endpoint row, provider decided after decrypt
  scope: PolicyScope;
  rank: number;
  /** Agent surfaces: workspace+account ahead of workspace, after the endpoint tie-break. */
  fine: number;
  revoked: boolean;
}

function describeRow(row: ProviderCredentialRow): string {
  return row.label && row.purpose === 'inference_key' ? `${row.purpose}/${row.label}` : row.purpose;
}

function matchStorage(row: ProviderCredentialRow, storages: readonly StorageMatch[]): StorageMatch | null {
  const label = (row.label ?? '').toLowerCase();
  return storages.find(s =>
    s.storage.purpose === row.purpose &&
    (s.storage.label === undefined || s.storage.label === label)) ?? null;
}

/**
 * `credentialScopeRank` from ../secrets/team-scope, restated: that module
 * imports `inArray`, which the wrappers' test stubs do not provide. A test
 * holds the two equal. -1 = does not apply; higher = more specific.
 */
export function scopeSpecificity(
  row: { userId: string | null; workspaceId: string | null; accountId: string | null },
  target: { accountId: string | null; workspaceId: string | null },
): number {
  if (row.userId) return -1;
  if (row.workspaceId && row.workspaceId !== target.workspaceId) return -1;
  if (row.accountId && row.accountId !== target.accountId) return -1;
  return (row.workspaceId ? 2 : 0) + (row.accountId ? 1 : 0);
}

/** Scope and rank of a row, or why it does not apply. Lower rank = more specific. */
function placeRow(
  row: ProviderCredentialRow,
  ctx: SelectContext,
  personalOk: boolean,
): { scope: PolicyScope; rank: number; fine?: number } | { skip: string } {
  const chat = !isAgentSurface(ctx.surface);
  if (row.userId) {
    if (!personalRowEligible(row.userId, ctx.requesterUserId)) return { skip: 'another person’s credential' };
    if (!personalOk) return { skip: 'this provider has no personal credentials yet' };
    return { scope: 'personal', rank: 0 };
  }
  if (row.workspaceId && row.workspaceId !== ctx.workspaceId) return { skip: 'another workspace' };
  if (chat) {
    if (row.accountId) {
      if (ctx.accountId) return row.accountId === ctx.accountId ? { scope: 'account', rank: 1 } : { skip: 'another account' };
      return { scope: 'account', rank: 4 };
    }
    return row.workspaceId ? { scope: 'workspace', rank: 2 } : { scope: 'team', rank: 3 };
  }
  if (row.purpose === ENDPOINT_PURPOSE && row.accountId) return { skip: 'an endpoint is never account-scoped' };
  const specificity = scopeSpecificity(row, { accountId: ctx.accountId, workspaceId: ctx.workspaceId });
  if (specificity < 0) return { skip: 'another account' };
  // Coarse rank workspace > account > team decides against an endpoint (which
  // is never account-scoped, so a workspace+account row ties a workspace
  // endpoint, as `competingScopes` has it); `fine` then puts workspace+account
  // ahead of workspace among the rest, as `pickMostSpecificCredential` does.
  const scope: PolicyScope = row.workspaceId ? 'workspace' : row.accountId ? 'account' : 'team';
  return { scope, rank: { workspace: 1, account: 2, team: 3 }[scope as 'workspace' | 'account' | 'team'], fine: 3 - specificity };
}

/**
 * Rank the rows and decrypt the first viable one. Pure given `decrypt`, so the
 * whole decision is table-testable. Never throws for a bad row.
 */
export function selectProviderCredential(
  rows: readonly ProviderCredentialRow[],
  ctx: SelectContext,
  decrypt: (encrypted: string) => string,
): ProviderCredentialResult {
  const why: string[] = [];
  const policy = appliedPolicy({ policy: ctx.policy.policy, surface: ctx.surface, agentEnforced: ctx.policy.enforced });
  const requester = normalizeRequester(ctx.requesterUserId);
  const agent = isAgentSurface(ctx.surface);
  why.push(
    `policy: ${policy}` +
      (agent && !ctx.policy.enforced ? ' (agent runs use team credentials until the team sets a credential policy)' : '') +
      ` [from ${ctx.policy.source}]`,
  );
  why.push(requester ? 'requester: present' : 'requester: none (team work)');

  const storages = storagesFor(ctx.surface, ctx.eligible, ctx.purposes);
  const endpoints = readsEndpoints(ctx.surface, ctx.eligible, ctx.purposes);
  const scopeAsked = (scope: PolicyScope) => !ctx.scopes || ctx.scopes.includes(scope);
  const scopeOpen = (scope: PolicyScope) =>
    policyAllowsScope({ policy: ctx.policy.policy, scope, hasRequester: !!requester, surface: ctx.surface, agentEnforced: ctx.policy.enforced });

  const candidates: Candidate[] = [];
  for (const row of rows) {
    const isEndpoint = row.purpose === ENDPOINT_PURPOSE;
    if (isEndpoint && !endpoints) continue;
    const match = isEndpoint ? null : matchStorage(row, storages);
    if (!isEndpoint && !match) continue; // a purpose/label this resolve did not ask for
    const personalOk = match ? personalScopeDelivered(providerDescriptor(match.provider)) : false;
    const placed = placeRow(row, ctx, personalOk);
    const name = `${describeRow(row)} ${row.id}`;
    if ('skip' in placed) {
      why.push(`${name}: skipped, ${placed.skip}`);
      continue;
    }
    if (!scopeAsked(placed.scope)) {
      why.push(`${placed.scope} ${name}: skipped, not a scope this caller reads`);
      continue;
    }
    if (!scopeOpen(placed.scope)) {
      why.push(`${placed.scope} ${name}: forbidden by policy (${policyScopeReason({ policy: ctx.policy.policy, scope: placed.scope, hasRequester: !!requester, surface: ctx.surface, agentEnforced: ctx.policy.enforced })})`);
      continue;
    }
    const revoked = row.healthStatus === 'revoked';
    if (agent && (isEndpoint || REFRESH_FAMILIES.includes(row.purpose)) && revoked) {
      why.push(`${placed.scope} ${name}: skipped, revoked`);
      continue;
    }
    if (agent && row.purpose === 'claude_credential' && !row.tokenExpiresAt) {
      why.push(`${placed.scope} ${name}: skipped, dead refresh family (no expiry)`);
      continue;
    }
    candidates.push({ row, match, scope: placed.scope, rank: placed.rank, fine: placed.fine ?? 0, revoked });
  }

  const newest = (c: Candidate) => c.row.updatedAt?.getTime() ?? 0;
  const providerIdx = (c: Candidate) => c.match?.providerIndex ?? -1;
  const storageIdx = (c: Candidate) => c.match?.storageIndex ?? 0;
  candidates.sort(agent
    ? (a, b) =>
        Number(a.revoked) - Number(b.revoked) ||
        a.rank - b.rank ||
        Number(b.match === null) - Number(a.match === null) || // endpoint wins a tie
        a.fine - b.fine ||
        providerIdx(a) - providerIdx(b) ||
        storageIdx(a) - storageIdx(b) ||
        newest(b) - newest(a)
    : (a, b) =>
        a.rank - b.rank ||
        providerIdx(a) - providerIdx(b) ||
        storageIdx(a) - storageIdx(b) ||
        Number(a.revoked) - Number(b.revoked) ||
        newest(b) - newest(a));

  let winner: ProviderCredentialResult | null = null;
  for (const c of candidates) {
    const name = `${c.scope} ${describeRow(c.row)} ${c.row.id}`;
    if (winner) {
      why.push(`${name}: outranked by ${winner.scope} ${winner.provider}`);
      continue;
    }
    let value: string;
    try {
      value = decrypt(c.row.encryptedValue);
    } catch {
      why.push(`${name}: could not be decrypted`);
      continue;
    }
    if (!value) {
      why.push(`${name}: empty`);
      continue;
    }
    if (ctx.accept && !ctx.accept(value)) {
      why.push(`${name}: not a usable value`);
      continue;
    }
    let provider: ProviderId;
    let shape: CredentialShape['id'];
    let endpoint: AgentEndpointBlob | undefined;
    if (c.match) {
      provider = c.match.provider;
      shape = c.match.shape;
    } else {
      const blob = parseAgentEndpointBlob(value);
      if (!blob) {
        why.push(`${name}: not a valid endpoint`);
        continue;
      }
      if (!endpointAppliesTo(blob, c.row.workspaceId, ctx.workspaceId)) {
        why.push(`${name}: endpoint does not apply to this workspace`);
        continue;
      }
      provider = ENDPOINT_KIND_PROVIDER[blob.kind];
      if (!ctx.eligible.includes(provider)) {
        const support = providerDescriptor(provider).surfaces[ctx.surface];
        why.push(`${name}: routes to ${provider}, ${support.ok ? 'not in the provider preference' : support.reason}`);
        continue;
      }
      shape = 'endpoint';
      endpoint = blob;
    }
    why.push(`${name}: used (${provider}${c.revoked ? ', revoked: the only candidate left' : ''})`);
    winner = {
      credential: { provider, shape, value, ...(endpoint ? { endpoint } : {}), tokenExpiresAt: c.row.tokenExpiresAt ?? null },
      provider,
      scope: c.scope,
      source: {
        scope: c.scope,
        secretId: c.row.id,
        purpose: c.row.purpose as ModelCredentialPurpose,
        label: c.row.label,
        legacy: c.match?.legacy ?? false,
      },
      why,
    };
  }

  if (!winner && !agent && ctx.env?.allowed && scopeAsked('env') && scopeOpen('env')) {
    for (const id of ctx.eligible) {
      const route = providerDescriptor(id).route;
      const envVar = route ? ROUTES[route].key?.envVar : undefined;
      const value = envVar ? ctx.env.values[envVar] : undefined;
      if (!envVar || !value || (ctx.accept && !ctx.accept(value))) continue;
      why.push(`env ${envVar}: used (${id})`);
      const shape = providerDescriptor(id).shapes[0].id;
      winner = {
        credential: { provider: id, shape, value, tokenExpiresAt: null },
        provider: id,
        scope: 'env',
        source: { scope: 'env', secretId: null, purpose: null, label: null, legacy: false, envVar },
        why,
      };
      break;
    }
  }

  for (const id of ctx.eligible) {
    if (winner && winner.provider === id) continue;
    if (!candidates.some(c => c.match?.provider === id) && !(id === 'litellm' && agent)) {
      why.push(`${id}: no row`);
    }
  }
  if (winner) return winner;

  const personalOnly = policy === 'personal_only';
  if (personalOnly && !requester) why.push('nothing to use: the policy is personal keys only and this work has no requester');
  return {
    none: true,
    reason: personalOnly ? NO_PERSONAL_CREDENTIAL : 'no_credential',
    why,
  };
}

// ── The resolver (DB) ────────────────────────────────────────────────────────

/**
 * May a provider env var stand in for a stored key? Never in production unless
 * a self-hosted deploy opts in. Same rule as `envKeysAllowed` in
 * ../inference-keys (a test holds them equal); not imported, because core does
 * not import that module.
 */
export function providerEnvKeysAllowed(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.NODE_ENV !== 'production' || env.BUILDD_ALLOW_ENV_INFERENCE_KEYS === '1';
}

async function loadTeamPolicy(teamId: string): Promise<TeamPolicyColumns | null> {
  try {
    const { db } = await import('../db');
    const { teams } = await import('../db/schema');
    return (await db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      columns: { credentialPolicy: true, inferenceKeyPolicy: true },
    })) ?? null;
  } catch (e) {
    console.warn('[providers/resolve] team policy lookup failed:', e);
    // Unreadable reads as unset: chat falls back to personal_first, agents to team.
    return null;
  }
}

/** See the module comment. Never throws. */
export async function resolveProviderCredential(input: ResolveProviderCredentialInput): Promise<ProviderCredentialResult> {
  const preference = input.provider ? [input.provider] : input.providers;
  const { eligible, impossible } = eligibleProviders(input.surface, preference);
  const team = input.team !== undefined ? input.team : await loadTeamPolicy(input.teamId);
  const policy = surfacePolicy(team, input.surface);
  const applied = appliedPolicy({ policy: policy.policy, surface: input.surface, agentEnforced: policy.enforced });
  const requester = normalizeRequester(input.requesterUserId);

  let rows: ProviderCredentialRow[] = [];
  const purposes = resolvePurposes(input.surface, eligible, input.purposes);
  const scopeAsked = (scope: PolicyScope) => !input.scopes || input.scopes.includes(scope);
  if (purposes.length > 0) {
    try {
      const { db } = await import('../db');
      rows = (await db.query.secrets.findMany({
        where: providerCredentialWhere({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          requesterUserId: requester,
          purposes,
          personalAllowed: applied !== 'team' && scopeAsked('personal'),
          legacyAccountRows: !isAgentSurface(input.surface) && scopeAsked('account'),
        }),
        columns: {
          id: true, purpose: true, label: true, encryptedValue: true, accountId: true, workspaceId: true,
          userId: true, healthStatus: true, tokenExpiresAt: true, updatedAt: true,
        },
      })) as ProviderCredentialRow[];
    } catch (e) {
      console.warn('[providers/resolve] credential lookup failed:', e);
    }
  }

  const decrypt = input.decrypt ?? (await import('../secrets/crypto')).decrypt;
  const result = selectProviderCredential(rows, {
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    requesterUserId: requester,
    surface: input.surface,
    eligible,
    policy,
    env: { allowed: providerEnvKeysAllowed(), values: process.env },
    purposes: input.purposes,
    scopes: input.scopes,
    accept: input.accept,
  }, decrypt);
  for (const { provider, reason } of impossible) result.why.push(`${provider}: impossible on ${input.surface} (${reason})`);
  return result;
}
