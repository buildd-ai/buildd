import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { db } from '@buildd/core/db';
import { connectors, secrets } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { encrypt, decrypt } from '@buildd/core/secrets';
import {
  exchangeCodeForToken,
  validateTokenAudience,
  verifyOAuthState,
  getCallbackUrl,
  OAUTH_STATE_COOKIE,
} from '@/lib/mcp-oauth';

export const dynamic = 'force-dynamic';

function errorRedirect(req: NextRequest, error: string) {
  const url = new URL('/app/connections', req.url);
  url.searchParams.set('error', error);
  return NextResponse.redirect(url);
}

/**
 * GET /api/connectors/callback
 *
 * OAuth 2.1 callback for MCP connector authorization.
 * Validates state, exchanges authorization code, stores tokens, redirects.
 */
export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const code = searchParams.get('code');
  const stateParam = searchParams.get('state');
  const errorParam = searchParams.get('error');

  // Handle AS-returned errors (e.g. user denied)
  if (errorParam) {
    const desc = searchParams.get('error_description') ?? errorParam;
    return errorRedirect(req, desc);
  }

  if (!code || !stateParam) {
    return errorRedirect(req, 'missing_code_or_state');
  }

  // Verify state cookie
  const cookieStore = await cookies();
  const stateCookie = cookieStore.get(OAUTH_STATE_COOKIE)?.value;
  if (!stateCookie) {
    return errorRedirect(req, 'missing_state_cookie');
  }

  const stateClaims = await verifyOAuthState(stateCookie);
  if (!stateClaims) {
    return errorRedirect(req, 'invalid_state_cookie');
  }

  if (stateClaims.state !== stateParam) {
    return errorRedirect(req, 'state_mismatch');
  }

  const { connectorId, codeVerifier, userId } = stateClaims;

  // Load connector row
  const connector = await db.query.connectors.findFirst({
    where: eq(connectors.id, connectorId),
  });

  if (!connector) {
    return errorRedirect(req, 'connector_not_found');
  }

  if (connector.authMode !== 'oauth') {
    return errorRedirect(req, 'connector_not_oauth');
  }

  // Resolve token endpoint from discoveredMetadata
  const meta = connector.discoveredMetadata as Record<string, unknown> | null;
  const asMetadata = meta?.['authorizationServer'] as Record<string, string> | undefined;
  const tokenEndpoint = asMetadata?.['token_endpoint'];

  if (!tokenEndpoint) {
    return errorRedirect(req, 'missing_token_endpoint');
  }

  // Decrypt client secret if present
  let clientSecret: string | null = null;
  if (connector.encryptedClientSecret) {
    try {
      clientSecret = decrypt(connector.encryptedClientSecret);
    } catch {
      return errorRedirect(req, 'credential_decrypt_failed');
    }
  }

  const clientId = connector.clientId;
  if (!clientId) {
    return errorRedirect(req, 'missing_client_id');
  }

  const callbackUrl = getCallbackUrl(req.nextUrl.origin);

  // Exchange code for tokens
  let tokenResponse;
  try {
    tokenResponse = await exchangeCodeForToken(
      tokenEndpoint,
      code,
      codeVerifier,
      clientId,
      clientSecret,
      callbackUrl,
    );
  } catch (err) {
    console.error('[connectors/callback] Token exchange failed:', err);
    return errorRedirect(req, 'token_exchange_failed');
  }

  // Validate audience — connector URL is the resource URL
  try {
    validateTokenAudience(tokenResponse.access_token, connector.url);
  } catch (err) {
    console.error('[connectors/callback] Audience validation failed:', err);
    return errorRedirect(req, 'invalid_token_audience');
  }

  // Persist tokens: single encrypted JSON blob per connector
  const tokenBlob = JSON.stringify({
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token ?? null,
  });

  const tokenExpiresAt = tokenResponse.expires_in
    ? new Date(Date.now() + tokenResponse.expires_in * 1000)
    : null;

  const encryptedValue = encrypt(tokenBlob);

  // Upsert secret: find existing by (teamId, purpose, label) then update or insert
  const existingSecret = await db.query.secrets.findFirst({
    where: and(
      eq(secrets.teamId, connector.teamId),
      eq(secrets.purpose, 'mcp_connector_credential'),
      eq(secrets.label, connectorId),
    ),
    columns: { id: true },
  });

  if (existingSecret) {
    await db.update(secrets)
      .set({
        encryptedValue,
        tokenExpiresAt,
        lastRefreshedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(secrets.id, existingSecret.id));
  } else {
    await db.insert(secrets).values({
      teamId: connector.teamId,
      accountId: null,
      workspaceId: null,
      purpose: 'mcp_connector_credential',
      label: connectorId,
      encryptedValue,
      tokenExpiresAt,
    });
  }

  // Clear the state cookie
  const response = NextResponse.redirect(
    new URL(`/app/connections?connected=${encodeURIComponent(connectorId)}`, req.url),
  );
  response.cookies.delete(OAUTH_STATE_COOKIE);
  return response;
}
