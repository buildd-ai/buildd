/**
 * Cloudflare AI Gateway Run tokens, minted from the team's Cloudflare
 * credential: one per person, and one team-wide token for agents.
 *
 * ## Why
 *
 * The team's `cloudflare_token` can deploy Workers. It is fine server-side,
 * but it should not be what every model call spends, and it must never reach a
 * runner. A minted token can only run models (AI Gateway Run, Workers AI
 * Read), expires, shows up on its own in Cloudflare's analytics, and is
 * revoked on its own: one person, or the agents' token, without touching the
 * rest.
 *
 * ## Storage
 *
 * `secrets` purpose `cloudflare_gateway_token` (no new table,
 * docs/credentials-architecture.md). A person's row has `userId` set (a
 * PERSONAL_SECRET_PURPOSES entry, so no team read returns it); the team's
 * agents token has none. Account and workspace NULL. One row per scope
 * (`replaceScoped`). The encrypted value is JSON
 * `{ token, tokenId, accountId, expiresOn }`.
 *
 * ## Minting
 *
 * Account-owned tokens (`POST /accounts/<id>/tokens`), so they outlive the
 * person who created them. The team token needs Account API Tokens Edit for
 * that; without it Cloudflare answers 403 and the error says so. Permission
 * groups are looked up by name, never by a hard-coded id.
 *
 * ## Where they are used
 *
 * - Decision calls via Cloudflare (`decision-client.ts`): the acting person's
 *   token, else the team's, else the team's `cloudflare_token` as before.
 * - Agent runs through a `cloudflare` agent endpoint (`agent-endpoint.ts`):
 *   the team's token as `cf-aig-authorization`, when the endpoint has no
 *   pasted gateway token of its own.
 *
 * Pure helpers and the Cloudflare calls (with an injected fetch) at the top;
 * the DB is imported lazily in the resolver.
 */

export const CLOUDFLARE_GATEWAY_TOKEN_PURPOSE = 'cloudflare_gateway_token' as const;

/** Permission groups a minted token gets, by Cloudflare's dashboard name. */
export const GATEWAY_TOKEN_PERMISSIONS = ['AI Gateway Run', 'Workers AI Read'] as const;

/** Lifetime of a minted token. Minting again replaces it. */
export const GATEWAY_TOKEN_TTL_DAYS = 90;

const CF_API = 'https://api.cloudflare.com/client/v4';
const ACCOUNT_RE = /^[0-9a-f]{32}$/;
const TOKEN_RE = /^[A-Za-z0-9_\-.]{20,200}$/;
const TOKEN_ID_RE = /^[A-Za-z0-9]{8,64}$/;

export interface GatewayRunToken {
  token: string;
  tokenId: string;
  accountId: string;
  /** ISO timestamp, or null when Cloudflare set none. */
  expiresOn: string | null;
}

export function serializeGatewayRunToken(t: GatewayRunToken): string {
  return JSON.stringify({ token: t.token, tokenId: t.tokenId, accountId: t.accountId, expiresOn: t.expiresOn });
}

/** The decrypted value, or null when it is not a well-formed minted token. */
export function parseGatewayRunToken(value: string | null | undefined): GatewayRunToken | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value) as Record<string, unknown>;
    if (typeof v.token !== 'string' || !TOKEN_RE.test(v.token)) return null;
    if (typeof v.tokenId !== 'string' || !TOKEN_ID_RE.test(v.tokenId)) return null;
    if (typeof v.accountId !== 'string' || !ACCOUNT_RE.test(v.accountId)) return null;
    const expiresOn = typeof v.expiresOn === 'string' && !Number.isNaN(Date.parse(v.expiresOn)) ? v.expiresOn : null;
    return { token: v.token, tokenId: v.tokenId, accountId: v.accountId, expiresOn };
  } catch {
    return null;
  }
}

/** Expired (or about to, within a minute). A token without an expiry never is. */
export function gatewayTokenExpired(t: Pick<GatewayRunToken, 'expiresOn'>, now: number = Date.now()): boolean {
  return !!t.expiresOn && Date.parse(t.expiresOn) <= now + 60_000;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type MintResult =
  | { ok: true; value: GatewayRunToken }
  | { ok: false; status: number; error: string };

interface CfEnvelope<T> {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
}

async function cfCall<T>(fetcher: Fetcher, url: string, apiToken: string, init: RequestInit = {}): Promise<{ res: Response; body: CfEnvelope<T> }> {
  const res = await fetcher(url, {
    ...init,
    headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(10_000),
  });
  let body: CfEnvelope<T> = {};
  try { body = (await res.json()) as CfEnvelope<T>; } catch { /* a proxy page: status only */ }
  return { res, body };
}

function cfError(res: Response, body: CfEnvelope<unknown>): string {
  const msg = body.errors?.map(e => e.message).filter(Boolean).join('; ');
  return msg ? `HTTP ${res.status}: ${msg}` : `HTTP ${res.status}`;
}

/** The request body for an account-owned token with these permission group ids. Pure. */
export function gatewayTokenRequest(opts: { accountId: string; name: string; permissionGroupIds: readonly string[]; expiresOn: string }) {
  return {
    name: opts.name,
    policies: [{
      effect: 'allow',
      resources: { [`com.cloudflare.api.account.${opts.accountId}`]: '*' },
      permission_groups: opts.permissionGroupIds.map(id => ({ id })),
    }],
    expires_on: opts.expiresOn,
  };
}

/**
 * Mint an AI Gateway Run token on the team's account with its Cloudflare
 * credential. Never throws; the error is safe to show (Cloudflare's message
 * and a status, never a token).
 */
export async function mintGatewayRunToken(
  cred: { apiToken: string; accountId: string },
  opts: { name: string; now?: number; ttlDays?: number; fetcher?: Fetcher } ,
): Promise<MintResult> {
  const fetcher = opts.fetcher ?? fetch;
  if (!ACCOUNT_RE.test(cred.accountId)) return { ok: false, status: 400, error: 'The Cloudflare account ID is malformed.' };
  try {
    const groups = await cfCall<Array<{ id?: string; name?: string }>>(fetcher, `${CF_API}/accounts/${cred.accountId}/tokens/permission_groups`, cred.apiToken);
    if (!groups.res.ok || !Array.isArray(groups.body.result)) {
      const why = groups.res.status === 401 || groups.res.status === 403
        ? 'The team\'s Cloudflare token cannot create tokens. Give it Account API Tokens: Edit, then try again.'
        : `Cloudflare did not list permission groups (${cfError(groups.res, groups.body)}).`;
      return { ok: false, status: groups.res.status === 401 || groups.res.status === 403 ? 400 : 502, error: why };
    }
    const byName = new Map(groups.body.result.filter(g => g.id && g.name).map(g => [g.name!.toLowerCase(), g.id!]));
    const missing = GATEWAY_TOKEN_PERMISSIONS.filter(n => !byName.has(n.toLowerCase()));
    if (missing.length > 0) {
      return { ok: false, status: 502, error: `Cloudflare has no permission group named ${missing.join(' or ')} for this account.` };
    }
    const now = opts.now ?? Date.now();
    const expiresOn = new Date(now + (opts.ttlDays ?? GATEWAY_TOKEN_TTL_DAYS) * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const created = await cfCall<{ id?: string; value?: string; expires_on?: string }>(fetcher, `${CF_API}/accounts/${cred.accountId}/tokens`, cred.apiToken, {
      method: 'POST',
      body: JSON.stringify(gatewayTokenRequest({
        accountId: cred.accountId, name: opts.name,
        permissionGroupIds: GATEWAY_TOKEN_PERMISSIONS.map(n => byName.get(n.toLowerCase())!),
        expiresOn,
      })),
    });
    const r = created.body.result;
    if (!created.res.ok || !created.body.success || !r?.id || !r.value) {
      const why = created.res.status === 401 || created.res.status === 403
        ? 'The team\'s Cloudflare token cannot create tokens. Give it Account API Tokens: Edit, then try again.'
        : `Cloudflare did not create the token (${cfError(created.res, created.body)}).`;
      return { ok: false, status: created.res.status === 401 || created.res.status === 403 ? 400 : 502, error: why };
    }
    const value: GatewayRunToken = { token: r.value, tokenId: r.id, accountId: cred.accountId, expiresOn: r.expires_on ?? expiresOn };
    if (!parseGatewayRunToken(serializeGatewayRunToken(value))) {
      return { ok: false, status: 502, error: 'Cloudflare returned a token buildd cannot read.' };
    }
    return { ok: true, value };
  } catch (e) {
    return { ok: false, status: 502, error: `Could not reach Cloudflare (${e instanceof Error ? e.message : 'network error'}).` };
  }
}

/** Revoke a minted token at Cloudflare. A 404 counts as revoked. Never throws. */
export async function revokeGatewayRunToken(
  cred: { apiToken: string; accountId: string },
  tokenId: string,
  opts: { fetcher?: Fetcher } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!ACCOUNT_RE.test(cred.accountId) || !TOKEN_ID_RE.test(tokenId)) return { ok: false, error: 'malformed token reference' };
  try {
    const { res, body } = await cfCall(opts.fetcher ?? fetch, `${CF_API}/accounts/${cred.accountId}/tokens/${tokenId}`, cred.apiToken, { method: 'DELETE' });
    if (res.ok || res.status === 404) return { ok: true };
    return { ok: false, error: cfError(res, body) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network error' };
  }
}

/**
 * Which minted token a call spends: the person's own when there is one, else
 * the team's. Pure; rows are already decrypted and parsed. Expired tokens and
 * ones minted on another account are skipped.
 */
export function pickGatewayRunToken(
  rows: ReadonlyArray<{ userId: string | null; healthStatus?: string | null; value: GatewayRunToken | null }>,
  opts: { userId?: string | null; accountId: string; now?: number },
): { token: GatewayRunToken; scope: 'personal' | 'team' } | null {
  const usable = (r: (typeof rows)[number]) =>
    !!r.value && r.healthStatus !== 'revoked' && r.value.accountId === opts.accountId && !gatewayTokenExpired(r.value, opts.now);
  const mine = opts.userId ? rows.find(r => r.userId === opts.userId && usable(r)) : undefined;
  if (mine?.value) return { token: mine.value, scope: 'personal' };
  const team = rows.find(r => r.userId === null && usable(r));
  return team?.value ? { token: team.value, scope: 'team' } : null;
}

/**
 * The minted token a call for this team (and person) spends, or null. Never
 * throws: a lookup failure reads as none, and the caller falls back to what it
 * did before minted tokens existed.
 */
export async function resolveGatewayRunToken(opts: { teamId: string; userId?: string | null; accountId: string }): Promise<{ token: GatewayRunToken; scope: 'personal' | 'team' } | null> {
  try {
    const { db } = await import('./db');
    const { secrets } = await import('./db/schema');
    const { and, desc, eq, isNull, or } = await import('drizzle-orm');
    const { decrypt } = await import('./secrets');
    const rows = await db.query.secrets.findMany({
      where: and(
        eq(secrets.teamId, opts.teamId),
        eq(secrets.purpose, CLOUDFLARE_GATEWAY_TOKEN_PURPOSE),
        isNull(secrets.accountId),
        isNull(secrets.workspaceId),
        opts.userId ? or(isNull(secrets.userId), eq(secrets.userId, opts.userId)) : isNull(secrets.userId),
      ),
      orderBy: desc(secrets.updatedAt),
      columns: { userId: true, encryptedValue: true, healthStatus: true },
      limit: 4,
    });
    const parsed = (rows ?? [])
      // Re-checked in code: a loose WHERE must never hand one person another's token.
      .filter(r => r.userId === null || r.userId === opts.userId)
      .map(r => {
        let value: GatewayRunToken | null = null;
        try { value = parseGatewayRunToken(decrypt(r.encryptedValue)); } catch { value = null; }
        return { userId: r.userId ?? null, healthStatus: r.healthStatus, value };
      });
    return pickGatewayRunToken(parsed, { userId: opts.userId, accountId: opts.accountId });
  } catch (e) {
    console.warn('[cloudflare-gateway-tokens] lookup failed:', e);
    return null;
  }
}
