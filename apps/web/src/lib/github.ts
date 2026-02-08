import { db } from '@buildd/core/db';
import { githubInstallations, githubRepos } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { createSign, createPrivateKey } from 'crypto';

// GitHub App configuration
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_APP_CLIENT_ID = process.env.GITHUB_APP_CLIENT_ID;

// Support both base64-encoded key (preferred for Vercel) and raw key with \n
function getPrivateKey(): string | undefined {
  const base64Key = process.env.GITHUB_APP_PRIVATE_KEY_BASE64;
  if (base64Key) {
    return Buffer.from(base64Key, 'base64').toString('utf-8');
  }
  return process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
}
const GITHUB_APP_PRIVATE_KEY = getPrivateKey();
const GITHUB_APP_CLIENT_SECRET = process.env.GITHUB_APP_CLIENT_SECRET;
const GITHUB_APP_WEBHOOK_SECRET = process.env.GITHUB_APP_WEBHOOK_SECRET;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev';

export function isGitHubAppConfigured(): boolean {
  return !!(GITHUB_APP_ID && GITHUB_APP_PRIVATE_KEY && GITHUB_APP_CLIENT_ID);
}

export function getGitHubAppConfig() {
  return {
    appId: GITHUB_APP_ID,
    clientId: GITHUB_APP_CLIENT_ID,
    webhookSecret: GITHUB_APP_WEBHOOK_SECRET,
    appUrl: APP_URL,
    installUrl: `https://github.com/apps/${process.env.GITHUB_APP_SLUG || 'buildd'}/installations/new`,
  };
}

// Generate JWT for GitHub App authentication
function generateAppJWT(): string {
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

// GitHub API client for a specific installation
export async function githubApi(installationId: number, path: string, options: RequestInit = {}) {
  const token = await getInstallationToken(installationId);

  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API error: ${response.status} ${error}`);
  }

  return response.json();
}

// List repositories for an installation
export async function listInstallationRepos(installationId: number) {
  const data = await githubApi(installationId, '/installation/repositories');
  return data.repositories;
}

// Sync repositories for an installation to database
export async function syncInstallationRepos(installationIdUuid: string, ghInstallationId: number) {
  const repos = await listInstallationRepos(ghInstallationId);

  for (const repo of repos) {
    const existing = await db.query.githubRepos.findFirst({
      where: eq(githubRepos.repoId, repo.id),
    });

    const repoData = {
      installationId: installationIdUuid,
      repoId: repo.id,
      fullName: repo.full_name,
      name: repo.name,
      owner: repo.owner.login,
      private: repo.private,
      defaultBranch: repo.default_branch,
      htmlUrl: repo.html_url,
      description: repo.description,
      updatedAt: new Date(),
    };

    if (existing) {
      await db
        .update(githubRepos)
        .set(repoData)
        .where(eq(githubRepos.repoId, repo.id));
    } else {
      await db.insert(githubRepos).values(repoData);
    }
  }

  return repos.length;
}

// Verify webhook signature
export async function verifyWebhookSignature(payload: string, signature: string): Promise<boolean> {
  if (!GITHUB_APP_WEBHOOK_SECRET) {
    console.warn('GITHUB_APP_WEBHOOK_SECRET not set, skipping signature verification');
    return true;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(GITHUB_APP_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const expectedSignature = `sha256=${arrayBufferToHex(sig)}`;

  return signature === expectedSignature;
}

// Helper functions for JWT encoding
function base64UrlEncode(data: string | Buffer): string {
  let base64: string;
  if (typeof data === 'string') {
    base64 = Buffer.from(data).toString('base64');
  } else {
    base64 = data.toString('base64');
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Types for webhook events
export interface GitHubInstallationEvent {
  action: 'created' | 'deleted' | 'suspend' | 'unsuspend' | 'new_permissions_accepted';
  installation: {
    id: number;
    account: {
      login: string;
      id: number;
      type: 'Organization' | 'User';
      avatar_url: string;
    };
    repository_selection: 'all' | 'selected';
    permissions: Record<string, string>;
  };
  repositories?: Array<{
    id: number;
    full_name: string;
    name: string;
    private: boolean;
  }>;
}

export interface GitHubIssuesEvent {
  action: 'opened' | 'closed' | 'reopened' | 'edited' | 'labeled' | 'unlabeled';
  issue: {
    id: number;
    number: number;
    title: string;
    body: string | null;
    state: 'open' | 'closed';
    html_url: string;
    labels: Array<{ name: string }>;
  };
  repository: {
    id: number;
    full_name: string;
  };
  installation?: {
    id: number;
  };
}
