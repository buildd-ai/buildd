/** Shared GitHub App authentication for server and readout consumers. */
import { db } from './db';
import { githubInstallations } from './db/schema';
import { eq } from 'drizzle-orm';
import { createSign, createPrivateKey } from 'crypto';
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY_BASE64 ? Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_BASE64, 'base64').toString('utf-8') : process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
const base64UrlEncode = (data: string | Buffer) => Buffer.from(data).toString('base64url');

// Generate JWT for GitHub App authentication
export function generateAppJWT(): string {
  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
    throw new Error('GitHub App not configured');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - 60,  // Issued 60 seconds ago to account for clock drift
    exp: now + 600, // Expires in 10 minutes
    iss: GITHUB_APP_ID,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  // Use Node's crypto - handles both PKCS#1 and PKCS#8 key formats
  const privateKey = createPrivateKey(GITHUB_APP_PRIVATE_KEY);
  const sign = createSign('RSA-SHA256');
  sign.update(signatureInput);
  const signature = sign.sign(privateKey);

  return `${signatureInput}.${base64UrlEncode(signature)}`;
}

// Get installation access token
export async function getInstallationToken(installationId: number): Promise<string> {
  // Check if we have a cached token
  const installation = await db.query.githubInstallations.findFirst({
    where: eq(githubInstallations.installationId, installationId),
  });

  if (installation?.accessToken && installation.tokenExpiresAt) {
    const expiresAt = new Date(installation.tokenExpiresAt);
    // Use cached token if it has more than 5 minutes left
    if (expiresAt > new Date(Date.now() + 5 * 60 * 1000)) {
      return installation.accessToken;
    }
  }

  // Generate new token
  const appJwt = generateAppJWT();
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get installation token: ${error}`);
  }

  const data = await response.json();
  const token = data.token;
  const expiresAt = new Date(data.expires_at);

  // Cache the token
  if (installation) {
    await db
      .update(githubInstallations)
      .set({
        accessToken: token,
        tokenExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(githubInstallations.installationId, installationId));
  }

  return token;
}

