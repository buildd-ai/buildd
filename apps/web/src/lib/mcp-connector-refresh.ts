/**
 * OAuth token refresh for mcp_connector_credential secrets.
 *
 * Each mcp_connector_credential row holds an encrypted JSON blob
 * { access_token, refresh_token? } and is linked to a connector row via
 * secrets.label = connectors.id. The connector row carries the token_endpoint,
 * clientId, and (optionally) an encrypted clientSecret.
 *
 * Header-auth connectors hold static credentials and are skipped — no refresh possible.
 */

import { db } from '@buildd/core/db';
import { connectors, secrets } from '@buildd/core/db/schema';
import { decrypt, encrypt } from '@buildd/core/secrets';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';

const PURPOSE = 'mcp_connector_credential' as const;

export type McpRefreshResult =
  | 'refreshed'      // new tokens persisted
  | 'locked'         // another caller holds the 60-min lock
  | 'no_credential'  // secret row or refresh_token missing
  | 'skipped'        // connector uses header / none auth — no OAuth refresh
  | 'expired'        // invalid_grant or 4xx: tokenExpiresAt set to null
  | 'error';         // network or unexpected failure

interface McpTokenBlob {
  access_token: string;
  refresh_token?: string;
}

function decodeBlob(encryptedValue: string): McpTokenBlob {
  return JSON.parse(decrypt(encryptedValue)) as McpTokenBlob;
}

function encodeBlob(blob: McpTokenBlob): string {
  return encrypt(JSON.stringify(blob));
}

/**
 * Refresh the OAuth tokens for one mcp_connector_credential secret (by id).
 *
 * Uses a DB-level optimistic lock on `lastRefreshedAt` — only the first caller
 * within a 60-minute window proceeds; concurrent callers receive 'locked'.
 * Does NOT use db.transaction() — neon-http does not support interactive transactions.
 */
export async function refreshMcpConnectorCredential(secretId: string): Promise<McpRefreshResult> {
  // Atomically claim the refresh lock by bumping lastRefreshedAt.
  // Callers who lose the race (lastRefreshedAt already recent) get no rows back.
  const [claimed] = await db
    .update(secrets)
    .set({ lastRefreshedAt: sql`NOW()`, updatedAt: sql`NOW()` })
    .where(
      and(
        eq(secrets.id, secretId),
        eq(secrets.purpose, PURPOSE),
        or(
          isNull(secrets.lastRefreshedAt),
          lt(secrets.lastRefreshedAt, sql`NOW() - INTERVAL '60 minutes'`),
        ),
      ),
    )
    .returning();

  if (!claimed) {
    const exists = await db.query.secrets.findFirst({
      where: and(eq(secrets.id, secretId), eq(secrets.purpose, PURPOSE)),
      columns: { id: true },
    });
    return exists ? 'locked' : 'no_credential';
  }

  const blob = decodeBlob(claimed.encryptedValue);
  const currentRefreshToken = blob.refresh_token;
  if (!currentRefreshToken) return 'no_credential';

  // label = connector ID (set at token-exchange time)
  const connectorId = claimed.label;
  if (!connectorId) return 'no_credential';

  const connector = await db.query.connectors.findFirst({
    where: eq(connectors.id, connectorId),
    columns: {
      authMode: true,
      discoveredMetadata: true,
      clientId: true,
      encryptedClientSecret: true,
    },
  });

  if (!connector) return 'no_credential';

  // Static credentials have no refresh path.
  if (connector.authMode !== 'oauth') return 'skipped';

  const meta = connector.discoveredMetadata as {
    authorizationServer?: { token_endpoint?: string };
  } | null;

  const tokenEndpoint = meta?.authorizationServer?.token_endpoint;
  if (!tokenEndpoint) {
    console.warn(`[MCP Refresh] No token_endpoint for connector ${connectorId}`);
    return 'error';
  }

  const clientId = connector.clientId;
  if (!clientId) return 'error';

  const clientSecret = connector.encryptedClientSecret ? decrypt(connector.encryptedClientSecret) : null;

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: currentRefreshToken,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    if (clientSecret) {
      // client_secret_basic: credentials in Authorization header
      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      headers['Authorization'] = `Basic ${credentials}`;
    } else {
      // client_secret_post: client_id in body
      body.set('client_id', clientId);
    }

    const res = await fetch(tokenEndpoint, { method: 'POST', headers, body: body.toString() });

    if (!res.ok) {
      let errorCode: string | undefined;
      try {
        const errBody = await res.json() as Record<string, unknown>;
        errorCode = typeof errBody.error === 'string' ? errBody.error : undefined;
      } catch {
        // ignore JSON parse failure
      }

      const detail = errorCode ? `${res.status} ${errorCode}` : `HTTP ${res.status}`;

      // Mark credential as expired so the UI shows the reconnect banner.
      await db
        .update(secrets)
        .set({ tokenExpiresAt: null, lastVerificationError: detail, updatedAt: sql`NOW()` })
        .where(and(eq(secrets.id, secretId), eq(secrets.purpose, PURPOSE)));

      console.warn(`[MCP Refresh] Refresh failed for secret ${secretId}: ${detail}`);

      // invalid_grant and 4xx auth errors = credential is gone; other errors may be transient.
      const isAuthFailure = errorCode === 'invalid_grant' || res.status === 400 || res.status === 401;
      return isAuthFailure ? 'expired' : 'error';
    }

    const tokens = await res.json() as Record<string, unknown>;

    const newAccessToken = typeof tokens.access_token === 'string' ? tokens.access_token : blob.access_token;
    // Always persist the rotated refresh token when the AS provides one.
    const newRefreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : currentRefreshToken;
    const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : null;
    const tokenExpiresAt = expiresIn != null ? new Date(Date.now() + expiresIn * 1000) : null;

    await db
      .update(secrets)
      .set({
        encryptedValue: encodeBlob({ access_token: newAccessToken, refresh_token: newRefreshToken }),
        tokenExpiresAt,
        lastVerificationError: null,
        updatedAt: sql`NOW()`,
      })
      .where(and(eq(secrets.id, secretId), eq(secrets.purpose, PURPOSE)));

    console.log(`[MCP Refresh] Token refreshed for secret ${secretId}`);
    return 'refreshed';
  } catch (err) {
    console.warn(
      `[MCP Refresh] Refresh error for secret ${secretId}:`,
      err instanceof Error ? err.message : 'unknown',
    );
    return 'error';
  }
}
