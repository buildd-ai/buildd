import { db } from '@buildd/core/db';
import { githubInstallations } from '@buildd/core/db/schema';
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

  // Handle 204 No Content (e.g., repository_dispatch)
  if (response.status === 204) {
    return null;
  }

  return response.json();
}

// List repositories for an installation (with pagination)
export async function listInstallationRepos(installationId: number) {
  const allRepos: Array<Record<string, unknown>> = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const data = await githubApi(
      installationId,
      `/installation/repositories?per_page=${perPage}&page=${page}`
    );
    allRepos.push(...data.repositories);
    if (allRepos.length >= data.total_count || data.repositories.length < perPage) {
      break;
    }
    page++;
  }

  return allRepos;
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

// GitHub GraphQL API client for a specific installation
export async function githubGraphQL(
  installationId: number,
  query: string,
  variables: Record<string, unknown> = {}
) {
  const token = await getInstallationToken(installationId);

  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub GraphQL error: ${response.status} ${error}`);
  }

  const data = await response.json();
  if (data.errors?.length) {
    throw new Error(`GitHub GraphQL error: ${data.errors[0].message}`);
  }

  return data;
}

// Enable auto-merge on a PR (requires branch protection rules + auto-merge enabled on repo)
export async function enableAutoMerge(
  installationId: number,
  pullRequestNodeId: string,
  mergeMethod: 'SQUASH' | 'MERGE' | 'REBASE' = 'SQUASH'
): Promise<boolean> {
  try {
    await githubGraphQL(installationId, `
      mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
        enablePullRequestAutoMerge(input: {
          pullRequestId: $pullRequestId
          mergeMethod: $mergeMethod
        }) {
          pullRequest {
            autoMergeRequest {
              enabledAt
            }
          }
        }
      }
    `, {
      pullRequestId: pullRequestNodeId,
      mergeMethod,
    });
    return true;
  } catch (error) {
    console.warn('Failed to enable auto-merge (repo may not have it enabled):', error);
    return false;
  }
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

// Dispatch a repository_dispatch event to trigger GitHub Actions workflows
export async function dispatchToGitHubActions(
  installationId: number,
  repoFullName: string,
  task: {
    id: string;
    title: string;
    description: string | null;
    workspaceId: string;
    mode?: string;
    priority?: number;
  }
): Promise<boolean> {
  if (!isGitHubAppConfigured()) {
    return false;
  }

  try {
    const [owner, repo] = repoFullName.split('/');
    if (!owner || !repo) {
      console.error(`Invalid repo full name: ${repoFullName}`);
      return false;
    }

    await githubApi(installationId, `/repos/${owner}/${repo}/dispatches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: 'buildd-task',
        client_payload: {
          task_id: task.id,
          title: task.title,
          workspace_id: task.workspaceId,
          mode: task.mode || 'execution',
          priority: task.priority || 0,
        },
      }),
    });

    console.log(`Task ${task.id} dispatched to GitHub Actions: ${repoFullName}`);
    return true;
  } catch (error) {
    console.error(`GitHub Actions dispatch failed for ${repoFullName}:`, error);
    return false;
  }
}
