/**
 * Runner-side credential refresh.
 *
 * Talks to the control-plane's POST /api/runner/credential-refresh endpoint
 * using a three-step lock → provider → commit pattern.
 *
 * Returned values:
 *   'refreshed'      — new tokens committed to the DB
 *   'locked'         — another refresher holds the DB lock; proceed with existing token
 *   'no_credential'  — lock acquired but credential has no refresh_token (API key type)
 *   'error'          — provider failure; revoke call made for permanent errors (invalid_grant)
 */

import { classifyAuthErrorSeverity } from '@buildd/core/auth-error-classifier';

const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';

export type RunnerRefreshResult = 'refreshed' | 'locked' | 'no_credential' | 'error';

export async function runnerRefreshCredential(
  secretId: string,
  purpose: 'claude_credential' | 'codex_credential',
): Promise<RunnerRefreshResult> {
  const baseUrl = process.env.BUILDD_CLIENT_URL ?? 'https://buildd.dev';
  const apiKey = process.env.BUILDD_API_KEY ?? '';
  const endpoint = `${baseUrl}/api/runner/credential-refresh`;
  const authHeader = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  // ── Step 1: acquire the DB refresh lock ─────────────────────────────────────
  let lockRes: Response;
  try {
    lockRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ secretId, purpose, action: 'lock' }),
    });
  } catch (err) {
    console.warn(`[runner-refresh] Network error acquiring lock for ${secretId}:`, err instanceof Error ? err.message : String(err));
    return 'error';
  }

  if (!lockRes.ok) {
    console.warn(`[runner-refresh] Lock request failed for ${secretId}: HTTP ${lockRes.status}`);
    return 'error';
  }

  const lockBody = await lockRes.json() as { locked: boolean; refreshToken?: string | null; expiresAt?: string | null };
  if (!lockBody.locked) {
    return 'locked';
  }

  const { refreshToken } = lockBody;
  if (!refreshToken) {
    return 'no_credential';
  }

  // ── Step 2: call the provider token endpoint ─────────────────────────────────
  const tokenUrl = purpose === 'claude_credential' ? CLAUDE_TOKEN_URL : OPENAI_TOKEN_URL;
  const clientId = purpose === 'claude_credential'
    ? (process.env.CLAUDE_OAUTH_CLIENT_ID ?? '9d1c250a-e61b-44d9-88ed-5944d1962f5e')
    : (process.env.CODEX_OAUTH_CLIENT_ID ?? '');

  let providerRes: Response;
  try {
    providerRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }).toString(),
    });
  } catch (err) {
    console.warn(`[runner-refresh] Network error refreshing ${purpose} for ${secretId}:`, err instanceof Error ? err.message : String(err));
    return 'error';
  }

  if (!providerRes.ok) {
    if (providerRes.status === 400 || providerRes.status === 401) {
      // Parse the error body to determine if this is a permanent revocation.
      let errorText = `HTTP ${providerRes.status}`;
      try {
        const body = await providerRes.json() as Record<string, unknown>;
        const code = typeof body.error === 'string' ? body.error : '';
        const desc = typeof body.error_description === 'string' ? body.error_description : '';
        errorText = [code, desc].filter(Boolean).join(': ') || errorText;
      } catch { /* ignore json parse failure */ }

      if (classifyAuthErrorSeverity(errorText) === 'revoked') {
        try {
          await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeader },
            body: JSON.stringify({ secretId, purpose, action: 'revoke', reason: errorText }),
          });
        } catch (revokeErr) {
          console.warn(`[runner-refresh] Failed to post revoke for ${secretId}:`, revokeErr instanceof Error ? revokeErr.message : String(revokeErr));
        }
      }
    } else {
      // 5xx or other transient failure — leave the lock; the 60-minute window handles retry.
      console.warn(`[runner-refresh] Transient provider error for ${purpose} ${secretId}: HTTP ${providerRes.status}`);
    }
    return 'error';
  }

  // ── Step 3: commit the fresh tokens ──────────────────────────────────────────
  const tokens = await providerRes.json() as Record<string, unknown>;
  const newAccessToken = tokens.access_token as string;
  const newRefreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : refreshToken;
  const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : null;
  const expiresAt = expiresIn != null ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({
        secretId,
        purpose,
        action: 'commit',
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        expiresAt,
      }),
    });
  } catch (err) {
    console.warn(`[runner-refresh] Failed to commit tokens for ${secretId}:`, err instanceof Error ? err.message : String(err));
    return 'error';
  }

  console.log(`[runner-refresh] Refreshed ${purpose} for ${secretId}`);
  console.log(`[credential-refresh] RUNNER-ORIGIN refresh complete: secretId=${secretId} purpose=${purpose} expiresAt=${expiresAt}`);
  return 'refreshed';
}
