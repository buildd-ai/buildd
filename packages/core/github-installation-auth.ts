/** Shared GitHub App authentication for server and readout consumers. */
import { db } from './db';
import { githubInstallations } from './db/schema';
import { eq } from 'drizzle-orm';
import { signGitHubAppJwt } from '@buildd/shared/github-app-jwt';
import { sqlWhere } from './db/relational-sql';
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY_BASE64 ? Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_BASE64, 'base64').toString('utf-8') : process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');

// Generate JWT for GitHub App authentication
export function generateAppJWT(): string {
  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
    throw new Error('GitHub App not configured');
  }
  return signGitHubAppJwt(GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY);
}

// Get installation access token
export async function getInstallationToken(installationId: number): Promise<string> {
  // Check if we have a cached token
  const installation = await db.query.githubInstallations.findFirst({
    where: sqlWhere(eq(githubInstallations.installationId, installationId)),
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

