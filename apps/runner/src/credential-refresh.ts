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
 *   'rotation_lost'  — a prior rotation never completed, so the stored refresh token
 *                      may already have been consumed and replaced. Terminal: the
 *                      credential needs reconnecting and MUST NOT be retried.
 */

import { classifyAuthErrorSeverity } from '@buildd/core/auth-error-classifier';

const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';

export type RunnerRefreshResult =
  | 'refreshed'
  | 'locked'
  | 'no_credential'
  | 'error'
  | 'rotation_lost';

/**
 * Control-plane auth for this call. Pass the runner's resolved config — the key
 * normally lives in config.json, and `index.ts` documents BUILDD_API_KEY as a
 * CI/Docker override that is "NOT recommended". Reading only the env var meant
 * a stock install sent no Authorization header and 401'd on every attempt.
 */
export type RefreshAuth = {
  apiKey?: string;
  baseUrl?: string;
};

export async function runnerRefreshCredential(
  secretId: string,
  purpose: 'claude_credential' | 'codex_credential',
  auth: RefreshAuth = {},
): Promise<RunnerRefreshResult> {
  const baseUrl = auth.baseUrl ?? process.env.BUILDD_CLIENT_URL ?? 'https://buildd.dev';
  const apiKey = auth.apiKey ?? process.env.BUILDD_API_KEY ?? '';
  const endpoint = `${baseUrl}/api/runner/credential-refresh`;

  // Without a key every call is a guaranteed 401. Say so once and stop, rather
  // than walking the lock/commit sequence and warning about each rejection.
  if (!apiKey) {
    console.warn(
      `[runner-refresh] No control-plane API key available for ${secretId} — cannot refresh. ` +
      'Pass the runner config apiKey (config.json) or set BUILDD_API_KEY.',
    );
    return 'error';
  }

  const authHeader = { Authorization: `Bearer ${apiKey}` };

  /**
   * Give the refresh lock back after an attempt that never reached the provider.
   *
   * `lock` stamps a rotation marker on the credential, and only an outcome clears
   * it. So every exit that holds the lock without having got a successful provider
   * response has to say so, or the marker stands and the credential is declared a
   * lost rotation on the next cycle — a local DNS failure or an API-key credential
   * would be killed for nothing.
   *
   * The one exit that must NOT call this is a failure after the provider answered
   * successfully: there the token really may have rotated, and the marker is the
   * only record of it.
   */
  const releaseUnusedLock = async (why: string): Promise<void> => {
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ secretId, purpose, action: 'release' }),
      });
    } catch (err) {
      // Best effort. Failing to release only means the lock waits out its window
      // — and the marker then reads as a lost rotation, which is the safe error.
      console.warn(`[runner-refresh] Failed to release unused lock for ${secretId} (${why}):`, err instanceof Error ? err.message : String(err));
    }
  };

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

  const lockBody = await lockRes.json() as {
    locked: boolean;
    rotationLost?: boolean;
    refreshToken?: string | null;
    expiresAt?: string | null;
  };
  if (!lockBody.locked) {
    // Distinguish "someone else is refreshing, try later" from "a prior rotation
    // was lost". The provider rotates the refresh token on every use, so in the
    // second case the stored token is dead and there is nothing to come back to.
    if (lockBody.rotationLost) {
      console.warn(
        `[runner-refresh] Rotation lost for ${secretId} (${purpose}) — a previous refresh never ` +
        'completed, so the stored refresh token cannot be reused. The control plane has marked ' +
        'the credential as needing reconnection; not retrying.',
      );
      return 'rotation_lost';
    }
    return 'locked';
  }

  const { refreshToken } = lockBody;
  if (!refreshToken) {
    // API-key credential: there is nothing to rotate and the provider is never
    // contacted, so hand the lock straight back.
    await releaseUnusedLock('no refresh token');
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
    // The request never completed, so nothing was rotated.
    await releaseUnusedLock('provider unreachable');
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
        // revoke is itself a terminal outcome and resolves the rotation marker
        // server-side, so no release on top of it.
      } else {
        // A 4xx that is not a revocation is still a refusal — nothing rotated.
        await releaseUnusedLock(`provider refused: HTTP ${providerRes.status}`);
      }
    } else {
      // 5xx or other transient failure. The provider answered and refused, so
      // nothing was rotated — and when the runner drives the refresh the control
      // plane never sees this response, so nobody else will resolve the marker.
      console.warn(`[runner-refresh] Transient provider error for ${purpose} ${secretId}: HTTP ${providerRes.status}`);
      await releaseUnusedLock(`provider error: HTTP ${providerRes.status}`);
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
    // Do NOT release here. The provider already answered and rotated the refresh
    // token; this failure means the replacement is lost. The control plane's
    // rotation marker is exactly what records that, so leave it standing — the
    // next lock attempt will report rotationLost instead of presenting a consumed
    // token and getting an unexplained invalid_grant.
    return 'error';
  }

  console.log(`[runner-refresh] Refreshed ${purpose} for ${secretId}`);
  console.log(`[credential-refresh] RUNNER-ORIGIN refresh complete: secretId=${secretId} purpose=${purpose} expiresAt=${expiresAt}`);
  return 'refreshed';
}
