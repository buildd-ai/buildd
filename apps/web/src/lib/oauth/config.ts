// OAuth 2.1 configuration for the MCP connector. Tokens are workspace-scoped:
// the JWT carries a workspace claim and /api/mcp-oauth/[workspace] verifies
// the claim matches the URL path.

export const OAUTH_SCOPES = ['mcp'] as const;
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;            // 1 hour
export const AUTH_CODE_TTL_SECONDS = 10 * 60;               // 10 minutes
export const AUTH_CODE_BYTES = 32;
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days
export const REFRESH_TOKEN_BYTES = 32;

export function getIssuer(): string {
  const explicit = process.env.OAUTH_ISSUER;
  if (explicit) return explicit.replace(/\/$/, '');
  const nextAuthUrl = process.env.NEXTAUTH_URL || process.env.AUTH_URL;
  if (nextAuthUrl) return nextAuthUrl.replace(/\/$/, '');
  // On Vercel production, advertise the canonical custom domain — not the
  // per-deploy VERCEL_URL hostname. OAuth clients (claude.ai) cache the
  // issuer; if they get a preview hostname they redirect users there, which
  // isn't whitelisted by GitHub's OAuth App and rots when that deployment is
  // replaced.
  if (process.env.VERCEL_ENV === 'production') return 'https://buildd.dev';
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`;
  return 'http://localhost:3000';
}

/**
 * Workspace-scoped resource URL. Each issued token's `aud` claim points
 * at the workspace's MCP endpoint; mismatched tokens are rejected.
 */
export function getResourceUrl(workspaceId: string): string {
  return `${getIssuer()}/api/mcp-oauth/${workspaceId}`;
}

export function getJwtSecret(): Uint8Array {
  const secret = process.env.OAUTH_JWT_SECRET ?? process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error('OAUTH_JWT_SECRET (or AUTH_SECRET / NEXTAUTH_SECRET) must be set');
  }
  return new TextEncoder().encode(secret);
}
