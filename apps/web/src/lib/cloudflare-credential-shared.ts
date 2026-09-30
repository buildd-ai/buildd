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
}

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
