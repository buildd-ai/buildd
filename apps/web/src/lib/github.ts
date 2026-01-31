import { db } from '@buildd/core/db';
import { githubInstallations, githubRepos } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

// GitHub App configuration
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
const GITHUB_APP_CLIENT_ID = process.env.GITHUB_APP_CLIENT_ID;
const GITHUB_APP_CLIENT_SECRET = process.env.GITHUB_APP_CLIENT_SECRET;
const GITHUB_APP_WEBHOOK_SECRET = process.env.GITHUB_APP_WEBHOOK_SECRET;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd-three.vercel.app';

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
async function generateAppJWT(): Promise<string> {
  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
    throw new Error('GitHub App not configured');
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,  // Issued 60 seconds ago to account for clock drift
    exp: now + 600, // Expires in 10 minutes
    iss: GITHUB_APP_ID,
  };

  // Use Web Crypto API for JWT signing (works in Edge runtime)
  const header = { alg: 'RS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(GITHUB_APP_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
  );

  return `${encodedHeader}.${encodedPayload}.${base64UrlEncode(signature)}`;
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
  const appJwt = await generateAppJWT();
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
function base64UrlEncode(data: string | ArrayBuffer): string {
  let base64: string;
  if (typeof data === 'string') {
    base64 = btoa(data);
  } else {
    base64 = btoa(String.fromCharCode(...new Uint8Array(data)));
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN.*-----/, '')
    .replace(/-----END.*-----/, '')
    .replace(/\s/g, '');
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    view[i] = binary.charCodeAt(i);
  }
  return buffer;
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
