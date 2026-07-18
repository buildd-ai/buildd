/**
 * Assertion exchange flow — spec §F.1 steps 2–4.
 *
 * Factored out of workers.ts so hook-factory.ts can call it for mid-task 401
 * re-auth (§F.2) without creating a circular import.
 */

const FETCH_TIMEOUT_MS = 30_000;

/**
 * Perform the mint → token-exchange flow for one assertion-mode connector.
 * Returns `{ accessToken, expiresAt }` on success; throws on any error.
 *
 * Step 2: POST {mintApiUrl} with worker credentials → receives a signed assertion JWT.
 * Step 3: POST {tokenEndpoint} with the assertion → receives a short-lived access token.
 */
export async function exchangeAssertionConnector(
  connector: { mintApiUrl: string; tokenEndpoint: string },
  apiKey: string,
  workerId: string,
  taskId: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  // Step 2: Mint an assertion JWT from the buildd mint API.
  const mintRes = await fetch(connector.mintApiUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workerId, taskId }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!mintRes.ok) {
    const text = await mintRes.text().catch(() => '');
    throw new Error(`Assertion mint failed: ${mintRes.status} ${text}`);
  }
  const mintBody = await mintRes.json() as {
    assertion: string;
    tokenEndpoint: string;
    audience: string;
    expiresAt: string;
  };

  // Use the tokenEndpoint returned by the mint API (it echoes the connector's configured endpoint).
  const tokenEndpoint = mintBody.tokenEndpoint ?? connector.tokenEndpoint;

  // Step 3: Exchange the assertion at the resource server's token endpoint.
  const tokenRes = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: mintBody.assertion,
    }).toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    throw new Error(`Token exchange failed: ${tokenRes.status} ${text}`);
  }
  const tokenBody = await tokenRes.json() as {
    access_token: string;
    token_type: string;
    expires_in?: number;
  };
  return {
    accessToken: tokenBody.access_token,
    expiresAt: Date.now() + (tokenBody.expires_in ?? 600) * 1000,
  };
}

/** Returns true if an error string looks like an HTTP 401 Unauthorized response. */
export function isAuthError(errorText: string): boolean {
  return /401|unauthorized/i.test(errorText);
}
