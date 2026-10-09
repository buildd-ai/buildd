import { SignJWT, decodeJwt, jwtVerify, type JWTPayload } from 'jose';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  getIssuer,
  getAccountResourceUrl,
  getJwtSecret,
  getResourceUrl,
} from './config';

/** A legacy workspace-bound access token. */
export interface AccessTokenClaims extends JWTPayload {
  sub: string;            // userId (UUID)
  scope: string;
  client_id: string;
  workspace_id: string;   // workspace this token grants access to
}

/**
 * An account-level access token. It names a grant, never a workspace: what it
 * reaches is resolved server-side per request (lib/mcp-grants.ts).
 */
export interface GrantAccessTokenClaims extends JWTPayload {
  sub: string;            // userId (UUID)
  scope: string;
  client_id: string;
  grant_id: string;       // mcp_oauth_grants.id
}

export type AnyAccessTokenClaims = AccessTokenClaims | GrantAccessTokenClaims;

export function isGrantClaims(claims: AnyAccessTokenClaims): claims is GrantAccessTokenClaims {
  return typeof (claims as { grant_id?: unknown }).grant_id === 'string';
}

export async function signAccessToken(args: {
  userId: string;
  workspaceId: string;
  clientId: string;
  scope: string;
}): Promise<{ token: string; expiresIn: number }> {
  const token = await new SignJWT({
    scope: args.scope,
    client_id: args.clientId,
    workspace_id: args.workspaceId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(args.userId)
    .setIssuer(getIssuer())
    .setAudience(getResourceUrl(args.workspaceId))
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(getJwtSecret());
  return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

/** Sign an account-level access token bound to user + client + grant. */
export async function signGrantAccessToken(args: {
  userId: string;
  grantId: string;
  clientId: string;
  scope: string;
}): Promise<{ token: string; expiresIn: number }> {
  const token = await new SignJWT({
    scope: args.scope,
    client_id: args.clientId,
    grant_id: args.grantId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(args.userId)
    .setIssuer(getIssuer())
    .setAudience(getAccountResourceUrl())
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(getJwtSecret());
  return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

/**
 * Verify a bearer token against the expected workspace. Returns null when the
 * signature is bad, the token is expired, or the workspace claim doesn't match
 * the URL path. The audience check uses the workspace-scoped resource URL so a
 * token issued for workspace A cannot be replayed against workspace B.
 */
export async function verifyAccessToken(
  token: string,
  expectedWorkspaceId: string,
): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret(), {
      issuer: getIssuer(),
      audience: getResourceUrl(expectedWorkspaceId),
    });
    if (typeof payload.sub !== 'string') return null;
    if (typeof payload.scope !== 'string') return null;
    if (typeof payload.client_id !== 'string') return null;
    if (typeof payload.workspace_id !== 'string') return null;
    if (payload.workspace_id !== expectedWorkspaceId) return null;
    if (payload.grant_id !== undefined) return null;
    return payload as AccessTokenClaims;
  } catch {
    return null;
  }
}

/**
 * Verify a bearer token without binding it to a specific workspace. Used by
 * `authenticateApiKey()` so internal HTTP self-calls (made by the MCP route
 * back into /api/*) can forward the original JWT instead of needing a
 * separately-minted API key. The workspace check is enforced separately by
 * the entry-point route at /api/mcp-oauth/[workspace].
 *
 * Returns null on any verification failure (bad signature, expired, etc.).
 */
export async function verifyAccessTokenAnyAudience(
  token: string,
): Promise<AnyAccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret(), {
      issuer: getIssuer(),
    });
    if (typeof payload.sub !== 'string') return null;
    if (typeof payload.scope !== 'string') return null;
    if (typeof payload.client_id !== 'string') return null;
    const hasWorkspace = typeof payload.workspace_id === 'string';
    const hasGrant = typeof payload.grant_id === 'string';
    // Exactly one binding. A token naming both (or neither) is ambiguous and refused.
    if (hasWorkspace === hasGrant) return null;
    if (hasGrant) {
      // A grant token is only valid at the account-level audience.
      const aud = payload.aud;
      const expected = getAccountResourceUrl();
      if (!(aud === expected || (Array.isArray(aud) && aud.length === 1 && aud[0] === expected))) return null;
      return payload as GrantAccessTokenClaims;
    }
    return payload as AccessTokenClaims;
  } catch {
    return null;
  }
}

/**
 * True when the bearer's (unverified) payload names a grant. Only routes a
 * token to the uncached path; that path still verifies it in full.
 */
export function looksLikeGrantToken(token: string): boolean {
  try {
    return typeof decodeJwt(token).grant_id === 'string';
  } catch {
    return false;
  }
}

/**
 * Cheap structural check used as a guard before calling the verifier — avoids
 * paying the jose round-trip on regular `bld_*` API keys. Three base64url
 * segments separated by dots is the JWT shape; the verifier still does the
 * authoritative check.
 */
export function looksLikeJwt(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}
