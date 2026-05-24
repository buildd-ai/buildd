import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  getIssuer,
  getJwtSecret,
  getResourceUrl,
} from './config';

export interface AccessTokenClaims extends JWTPayload {
  sub: string;            // userId (UUID)
  scope: string;
  client_id: string;
  workspace_id: string;   // workspace this token grants access to
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
): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret(), {
      issuer: getIssuer(),
    });
    if (typeof payload.sub !== 'string') return null;
    if (typeof payload.scope !== 'string') return null;
    if (typeof payload.client_id !== 'string') return null;
    if (typeof payload.workspace_id !== 'string') return null;
    return payload as AccessTokenClaims;
  } catch {
    return null;
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
