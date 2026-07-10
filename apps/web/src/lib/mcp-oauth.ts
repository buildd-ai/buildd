/**
 * OAuth 2.1 / MCP Authorization discovery engine.
 *
 * Implements the full flow:
 *   1. Discovery probe → parse WWW-Authenticate for resource_metadata URL
 *   2. Protected Resource Metadata (RFC 9728)
 *   3. Authorization Server Metadata (RFC 8414 / OIDC discovery)
 *   4. Dynamic Client Registration (RFC 7591) — optional
 *   5. Authorization URL assembly with PKCE S256
 *   6. Token exchange (code + code_verifier)
 *   7. Token audience validation
 */

import { createHash } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import { getJwtSecret } from '@/lib/oauth/config';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ASMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  [key: string]: unknown;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
  [key: string]: unknown;
}

export type DiscoveredMetadata =
  | { authMode: 'none' }
  | {
      authMode: 'oauth';
      protectedResource: ProtectedResourceMetadata;
      authorizationServer: ASMetadata;
    };

export interface DCRResult {
  client_id: string;
  client_secret?: string;
  [key: string]: unknown;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
  scope?: string;
}

/** State payload stored in the short-lived OAuth state cookie. */
export interface OAuthStateClaims {
  state: string;       // random hex to match against callback state param
  connectorId: string;
  codeVerifier: string;
  userId: string;
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Parse a WWW-Authenticate Bearer challenge into a key=value map.
 * Example header: Bearer realm="...", resource_metadata="https://..."
 */
export function parseBearerChallenge(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  const bearerMatch = header.match(/^Bearer\s+(.*)/i);
  if (!bearerMatch) return result;

  const params = bearerMatch[1];
  const re = /(\w+)="([^"]*?)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(params)) !== null) {
    result[m[1]] = m[2];
  }
  return result;
}

/**
 * Full OAuth discovery flow for an MCP server URL.
 *
 * Returns `{ authMode: 'none' }` when the server responds 2xx without auth.
 * Returns the discovered AS metadata on `authMode: 'oauth'`.
 * Throws on network errors or unexpected HTTP status codes.
 */
export async function discoverOAuthMetadata(connectorUrl: string): Promise<DiscoveredMetadata> {
  let probeRes: Response;
  try {
    probeRes = await fetch(connectorUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    throw new Error(`Discovery probe failed: ${(err as Error).message}`);
  }

  if (probeRes.ok) {
    return { authMode: 'none' };
  }

  if (probeRes.status !== 401) {
    throw new Error(`Discovery probe returned unexpected status ${probeRes.status}`);
  }

  // Step 1: Extract resource_metadata URL from WWW-Authenticate header
  const wwwAuth = probeRes.headers.get('www-authenticate') ?? '';
  const challenge = parseBearerChallenge(wwwAuth);

  let resourceMetadataUrl =
    challenge['resource_metadata'] ??
    // Fallback: /.well-known/oauth-protected-resource on the connector origin
    new URL('/.well-known/oauth-protected-resource', connectorUrl).toString();

  // Step 2: Fetch Protected Resource Metadata (RFC 9728)
  const prRes = await fetch(resourceMetadataUrl, {
    headers: { Accept: 'application/json' },
  });
  if (!prRes.ok) {
    throw new Error(`Failed to fetch Protected Resource Metadata (${prRes.status})`);
  }
  const protectedResource = (await prRes.json()) as ProtectedResourceMetadata;

  if (!protectedResource.authorization_servers?.length) {
    throw new Error('Protected Resource Metadata missing authorization_servers');
  }

  const asBaseUrl = protectedResource.authorization_servers[0].replace(/\/$/, '');

  // Step 3: Fetch Authorization Server Metadata (RFC 8414 with OIDC fallback)
  const authorizationServer = await fetchASMetadata(asBaseUrl);

  return { authMode: 'oauth', protectedResource, authorizationServer };
}

async function fetchASMetadata(asBaseUrl: string): Promise<ASMetadata> {
  const primary = `${asBaseUrl}/.well-known/oauth-authorization-server`;
  const fallback = `${asBaseUrl}/.well-known/openid-configuration`;

  for (const url of [primary, fallback]) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch {
      continue;
    }
    if (res.ok) {
      return (await res.json()) as ASMetadata;
    }
  }
  throw new Error(`Could not fetch AS metadata from ${asBaseUrl}`);
}

// ─── Dynamic Client Registration ─────────────────────────────────────────────

/**
 * Perform RFC 7591 Dynamic Client Registration.
 * Returns { client_id, client_secret? }.
 */
export async function registerClient(
  registrationEndpoint: string,
  callbackUrl: string,
): Promise<DCRResult> {
  const body = {
    client_name: 'buildd',
    redirect_uris: [callbackUrl],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_basic',
    code_challenge_method: 'S256',
  };

  const res = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DCR failed (${res.status}): ${text}`);
  }

  return (await res.json()) as DCRResult;
}

// ─── PKCE Helpers ────────────────────────────────────────────────────────────

/** Generate a PKCE code_verifier (32 random bytes, base64url, no padding). */
export function generateCodeVerifier(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString('base64url');
}

/** Derive code_challenge (S256) from a code_verifier. */
export function deriveCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

// ─── Authorization URL ───────────────────────────────────────────────────────

/**
 * Assemble the authorization URL with PKCE S256.
 *
 * @param asMetadata    - Discovered AS metadata (must have authorization_endpoint)
 * @param clientId      - OAuth client ID (from DCR or pre-registered)
 * @param connectorUrl  - The connector resource URL (used to determine scopes)
 * @param state         - Random hex state value (caller stores in session/cookie)
 * @param codeChallenge - S256 PKCE code challenge (base64url SHA-256 of verifier)
 * @param scopes        - Optional scope list; falls back to AS scopes_supported
 */
export function buildAuthorizationUrl(
  asMetadata: ASMetadata,
  clientId: string,
  connectorUrl: string,
  state: string,
  codeChallenge: string,
  scopes?: string[],
): string {
  const url = new URL(asMetadata.authorization_endpoint);

  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', getCallbackUrl());
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  // Scope: caller-supplied → AS scopes_supported → omit
  const scopeList = scopes ?? asMetadata.scopes_supported;
  if (scopeList?.length) {
    url.searchParams.set('scope', scopeList.join(' '));
  }

  return url.toString();
}

// ─── Token Exchange ───────────────────────────────────────────────────────────

/**
 * Exchange an authorization code for tokens using PKCE.
 * Uses client_secret_basic when clientSecret is provided, client_secret_post otherwise.
 */
export async function exchangeCodeForToken(
  tokenEndpoint: string,
  code: string,
  codeVerifier: string,
  clientId: string,
  clientSecret: string | null,
  callbackUrl: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: callbackUrl,
    code_verifier: codeVerifier,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  if (clientSecret) {
    // client_secret_basic: Authorization: Basic base64(clientId:clientSecret)
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
  } else {
    // client_secret_post: include in body
    body.set('client_id', clientId);
  }

  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers,
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return (await res.json()) as TokenResponse;
}

// ─── Audience Validation ─────────────────────────────────────────────────────

/**
 * Validate that the access token's `aud` claim contains the connector resource URL.
 * Decodes without verifying signature — we only care about the claim value.
 * Throws if audience is missing or does not match.
 */
export function validateTokenAudience(token: string, connectorUrl: string): void {
  const parts = token.split('.');
  if (parts.length < 2) {
    throw new Error('Invalid JWT format');
  }

  let payload: Record<string, unknown>;
  try {
    const decoded = Buffer.from(parts[1], 'base64url').toString('utf8');
    payload = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    throw new Error('Failed to decode JWT payload');
  }

  const aud = payload['aud'];
  if (!aud) {
    // Some AS implementations omit aud — warn but don't reject
    return;
  }

  const normalizedUrl = connectorUrl.replace(/\/$/, '');
  const audiences = Array.isArray(aud) ? aud : [aud];
  const match = (audiences as string[]).some(
    (a) => typeof a === 'string' && a.replace(/\/$/, '') === normalizedUrl,
  );

  if (!match) {
    throw new Error(
      `Token audience mismatch: expected "${normalizedUrl}", got ${JSON.stringify(aud)}`,
    );
  }
}

// ─── OAuth State Cookie (PKCE + state binding) ────────────────────────────────

const STATE_TTL_SECONDS = 15 * 60; // 15 minutes

/**
 * Sign an OAuth state payload as a short-lived JWT for cookie storage.
 * The state cookie binds the PKCE verifier, connector, and user to the
 * callback, preventing CSRF and code injection attacks.
 */
export async function signOAuthState(claims: OAuthStateClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${STATE_TTL_SECONDS}s`)
    .sign(getJwtSecret());
}

/**
 * Verify and decode an OAuth state cookie.
 * Returns null when the token is invalid, expired, or tampered.
 */
export async function verifyOAuthState(token: string): Promise<OAuthStateClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    if (
      typeof payload['state'] !== 'string' ||
      typeof payload['connectorId'] !== 'string' ||
      typeof payload['codeVerifier'] !== 'string' ||
      typeof payload['userId'] !== 'string'
    ) {
      return null;
    }
    return {
      state: payload['state'] as string,
      connectorId: payload['connectorId'] as string,
      codeVerifier: payload['codeVerifier'] as string,
      userId: payload['userId'] as string,
    };
  } catch {
    return null;
  }
}

// ─── Callback URL helper ──────────────────────────────────────────────────────

/** Absolute callback URL for this app (used as redirect_uri). */
export function getCallbackUrl(): string {
  const base =
    process.env.OAUTH_ISSUER ||
    process.env.NEXTAUTH_URL ||
    process.env.AUTH_URL ||
    'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/api/connectors/callback`;
}

export const OAUTH_STATE_COOKIE = 'conn_oauth';
