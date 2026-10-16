/**
 * Cloudflare API token for the cloud runner (apps/cloud-runner).
 *
 * Stored in the unified `secrets` table as purpose `cloudflare_token`,
 * team-wide, with an encrypted JSON value `{ apiToken, accountId, aiGatewayId? }`
 * (docs/credentials-architecture.md). The token deploys the dispatcher Worker
 * and, later, reaches AI Gateway. It never goes to a runner.
 *
 * This file is the pure half (parse, mask, verify against an injected fetch),
 * safe to import anywhere. The DB half is ./cloudflare-credential.ts.
 */

export const CLOUDFLARE_PURPOSE = 'cloudflare_token' as const;
export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

export interface CloudflareCredential {
  apiToken: string;
  accountId: string;
  aiGatewayId?: string;
}

/** What may leave the server about a stored credential. Never the token. */
export interface CloudflareCredentialMetadata {
  accountId: string;
  aiGatewayId: string | null;
  tokenHint: string;
}

// Cloudflare account IDs are 32 lowercase hex characters.
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
// Gateway IDs are slugs chosen in the dashboard.
const GATEWAY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Tokens are opaque, but never contain whitespace or quotes.
const TOKEN_RE = /^[A-Za-z0-9_\-.]{20,200}$/;

export type ParseResult =
  | { ok: true; value: CloudflareCredential }
  | { ok: false; error: string };

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

/**
 * Validate a credential given as a JSON string or object. Trims and unquotes
 * each field (pasted values often carry quotes). Returns a normalized value
 * with no extra keys, so nothing unexpected is ever encrypted and stored.
 */
export function parseCloudflareCredential(raw: unknown): ParseResult {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'Value must be JSON: { "apiToken", "accountId", "aiGatewayId"? }' };
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'Value must be an object with apiToken and accountId' };
  }
  const o = obj as Record<string, unknown>;
  const apiToken = typeof o.apiToken === 'string' ? unquote(o.apiToken) : '';
  const accountId = typeof o.accountId === 'string' ? unquote(o.accountId).toLowerCase() : '';
  const gatewayRaw = typeof o.aiGatewayId === 'string' ? unquote(o.aiGatewayId) : '';

  if (!apiToken) return { ok: false, error: 'apiToken is required' };
  if (!TOKEN_RE.test(apiToken)) return { ok: false, error: 'apiToken does not look like a Cloudflare API token' };
  if (!accountId) return { ok: false, error: 'accountId is required' };
  if (!ACCOUNT_ID_RE.test(accountId)) return { ok: false, error: 'accountId must be the 32-character hex account ID' };
  if (gatewayRaw && !GATEWAY_ID_RE.test(gatewayRaw)) {
    return { ok: false, error: 'aiGatewayId must be lowercase letters, digits, dashes or underscores' };
  }

  const value: CloudflareCredential = { apiToken, accountId };
  if (gatewayRaw) value.aiGatewayId = gatewayRaw;
  return { ok: true, value };
}

/** Masked metadata for display: first/last 4 of the account ID, last 4 of the token. */
export function maskCloudflareCredential(c: CloudflareCredential): CloudflareCredentialMetadata {
  return {
    accountId: `${c.accountId.slice(0, 4)}…${c.accountId.slice(-4)}`,
    aiGatewayId: c.aiGatewayId ?? null,
    tokenHint: `…${c.apiToken.slice(-4)}`,
  };
}

export interface CloudflareVerifyResult {
  verified: boolean;
  error: string | null;
  /** Which endpoint accepted the token: a user token or an account-owned one. */
  tokenKind?: 'user' | 'account';
  /** Cloudflare's own status for the token ('active', 'disabled', 'expired'). */
  tokenStatus?: string;
  expiresOn?: string | null;
  /** True when Cloudflare answered and said no (as opposed to a network error). */
  rejected?: boolean;
  /** What the token may do, checked only for an active token. See `checkCloudflareCapabilities`. */
  capabilities?: CloudflareCapabilities;
}

/** One permission check: Cloudflare said yes, said no, or could not be asked. */
export interface CapabilityCheck {
  state: 'allowed' | 'not_allowed' | 'not_found' | 'unknown';
  /** Cloudflare's own words, or the network error. */
  detail?: string;
}

export interface CloudflareCapabilities {
  /** Workers AI, which Clef decisions run on. */
  workersAi: CapabilityCheck;
  /** The AI Gateway named on the credential; null when none is set. */
  aiGateway: CapabilityCheck | null;
}

export type CloudflareCapability = keyof CloudflareCapabilities;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface CfVerifyBody {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: { id?: string; status?: string; expires_on?: string | null };
}

async function callVerify(url: string, token: string, fetchImpl: FetchLike) {
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  let body: CfVerifyBody = {};
  try {
    body = (await res.json()) as CfVerifyBody;
  } catch {
    // non-JSON (proxy error page): treat as a plain HTTP failure
  }
  return { res, body };
}

function describeFailure(res: Response, body: CfVerifyBody): string {
  const msg = body.errors?.map((e) => e.message).filter(Boolean).join('; ');
  return msg ? `HTTP ${res.status}: ${msg}` : `HTTP ${res.status}`;
}

/** Like `describeFailure`, with Cloudflare's error codes (10000 is "this token may not"). */
function describeWithCodes(res: Response, body: CfVerifyBody): string {
  const msg = body.errors
    ?.filter((e) => e.message)
    .map((e) => (e.code !== undefined ? `${e.message} (code ${e.code})` : e.message))
    .join('; ');
  return msg ? `HTTP ${res.status}: ${msg}` : `HTTP ${res.status}`;
}

const CAPABILITY_LABEL: Record<CloudflareCapability, { name: string; permission: string }> = {
  workersAi: { name: 'Workers AI', permission: 'Workers AI Read' },
  aiGateway: { name: 'AI Gateway', permission: 'AI Gateway Read' },
};

/** One read that only succeeds with the permission. 401/403 = not allowed, 404 = not found, else unknown. */
async function checkOne(url: string, token: string, fetchImpl: FetchLike): Promise<CapabilityCheck> {
  try {
    const { res, body } = await callVerify(url, token, fetchImpl);
    if (res.ok && body.success !== false) return { state: 'allowed' };
    const detail = describeWithCodes(res, body);
    if (res.status === 401 || res.status === 403) return { state: 'not_allowed', detail };
    if (res.status === 404) return { state: 'not_found', detail };
    return { state: 'unknown', detail };
  } catch (err) {
    return { state: 'unknown', detail: err instanceof Error ? err.message : 'Network error' };
  }
}

/**
 * What an active token may do beyond being active. A token can verify as
 * active and still be refused by Workers AI (401, code 10000), which is how a
 * team's Clef decisions can fail on every call behind a "Verified" chip.
 *
 * Both checks are free reads that need the same permission the real call
 * does: listing one Workers AI model (Workers AI Read), and reading the named
 * gateway (AI Gateway Read). Saving a decision model then runs one real
 * decision through the exact route (packages/core/decision-probe.ts).
 */
export async function checkCloudflareCapabilities(
  cred: CloudflareCredential,
  fetchImpl: FetchLike = fetch,
): Promise<CloudflareCapabilities> {
  const base = `${CLOUDFLARE_API_BASE}/accounts/${cred.accountId}`;
  const [workersAi, aiGateway] = await Promise.all([
    checkOne(`${base}/ai/models/search?per_page=1`, cred.apiToken, fetchImpl),
    cred.aiGatewayId
      ? checkOne(`${base}/ai-gateway/gateways/${encodeURIComponent(cred.aiGatewayId)}`, cred.apiToken, fetchImpl)
      : Promise.resolve(null),
  ]);
  return { workersAi, aiGateway };
}

/** The card's words for one check: "Workers AI: not allowed (add Workers AI Read to this token)". */
export function describeCloudflareCapability(which: CloudflareCapability, check: CapabilityCheck): string {
  const { name, permission } = CAPABILITY_LABEL[which];
  switch (check.state) {
    case 'allowed': return `${name}: allowed`;
    case 'not_allowed': return `${name}: not allowed (add ${permission} to this token)`;
    case 'not_found': return `${name}: not found (check the AI Gateway ID)`;
    default: return `${name}: could not check${check.detail ? ` (${check.detail})` : ''}`;
  }
}

/** The capability lines worth keeping on the row: only what is refused or missing. Null when all is well. */
export function capabilityProblems(caps: CloudflareCapabilities): string | null {
  const lines = (Object.keys(CAPABILITY_LABEL) as CloudflareCapability[])
    .map((k) => [k, caps[k]] as const)
    .filter((e): e is readonly [CloudflareCapability, CapabilityCheck] => !!e[1] && (e[1].state === 'not_allowed' || e[1].state === 'not_found'))
    .map(([k, c]) => describeCloudflareCapability(k, c));
  return lines.length ? lines.join('. ') : null;
}

/**
 * Check a token against Cloudflare. User tokens verify at
 * `/user/tokens/verify`; account-owned tokens only at
 * `/accounts/<id>/tokens/verify`. Try the account endpoint first (it is the
 * one that knows about the account we will deploy to), then the user one.
 * A token counts as verified only when Cloudflare says `status: active`.
 */
export async function verifyCloudflareToken(
  cred: CloudflareCredential,
  fetchImpl: FetchLike = fetch,
): Promise<CloudflareVerifyResult> {
  const attempts: Array<{ kind: 'account' | 'user'; url: string }> = [
    { kind: 'account', url: `${CLOUDFLARE_API_BASE}/accounts/${cred.accountId}/tokens/verify` },
    { kind: 'user', url: `${CLOUDFLARE_API_BASE}/user/tokens/verify` },
  ];
  let lastError = 'Verification failed';
  let rejected = false;
  for (const a of attempts) {
    try {
      const { res, body } = await callVerify(a.url, cred.apiToken, fetchImpl);
      if (res.ok && body.success) {
        const status = body.result?.status ?? 'unknown';
        if (status === 'active') {
          return { verified: true, error: null, tokenKind: a.kind, tokenStatus: status, expiresOn: body.result?.expires_on ?? null };
        }
        // Cloudflare knows the token but it cannot be used.
        return { verified: false, error: `Token is ${status}`, tokenKind: a.kind, tokenStatus: status, rejected: true };
      }
      lastError = describeFailure(res, body);
      rejected = res.status >= 400 && res.status < 500;
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Network error';
      rejected = false;
    }
  }
  return { verified: false, error: lastError, rejected };
}
