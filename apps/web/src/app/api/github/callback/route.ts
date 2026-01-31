import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { githubInstallations } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { syncInstallationRepos } from '@/lib/github';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.redirect(new URL('/auth/signin', req.url));
  }

  const searchParams = req.nextUrl.searchParams;
  const installationId = searchParams.get('installation_id');
  const setupAction = searchParams.get('setup_action'); // 'install', 'update', or 'request'
  const state = searchParams.get('state');

  if (!installationId) {
    return NextResponse.redirect(new URL('/workspaces?error=no_installation_id', req.url));
  }

  let returnUrl = '/workspaces';
  if (state) {
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64url').toString());
      returnUrl = decoded.returnUrl || '/workspaces';
    } catch {
      // Ignore decode errors
    }
  }

  // Fetch installation details from GitHub
  const appJwt = await generateAppJWT();
  const installationResponse = await fetch(
    `https://api.github.com/app/installations/${installationId}`,
    {
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );

  if (!installationResponse.ok) {
    const error = await installationResponse.text();
    console.error('Failed to fetch installation:', error);
    return NextResponse.redirect(new URL(`/workspaces?error=fetch_failed`, req.url));
  }

  const installation = await installationResponse.json();
  console.log('[GitHub Callback] Installation data:', JSON.stringify(installation.account));

  let installationDbId: string;

  try {
    // Check if installation already exists
    const existing = await db.query.githubInstallations.findFirst({
      where: eq(githubInstallations.installationId, parseInt(installationId)),
    });
    console.log('[GitHub Callback] Existing installation:', existing?.id || 'none');

    if (existing) {
      // Update existing installation
      await db
        .update(githubInstallations)
        .set({
          accountLogin: installation.account.login,
          accountAvatarUrl: installation.account.avatar_url,
          permissions: installation.permissions,
          repositorySelection: installation.repository_selection,
          suspendedAt: installation.suspended_at ? new Date(installation.suspended_at) : null,
          updatedAt: new Date(),
        })
        .where(eq(githubInstallations.installationId, parseInt(installationId)));
      installationDbId = existing.id;
      console.log('[GitHub Callback] Updated installation:', installationDbId);
    } else {
      // Create new installation record
      const [newInstallation] = await db
        .insert(githubInstallations)
        .values({
          installationId: parseInt(installationId),
          accountType: installation.account.type,
          accountLogin: installation.account.login,
          accountId: installation.account.id,
          accountAvatarUrl: installation.account.avatar_url,
          permissions: installation.permissions,
          repositorySelection: installation.repository_selection,
        })
        .returning();
      installationDbId = newInstallation.id;
      console.log('[GitHub Callback] Created installation:', installationDbId);
    }
  } catch (dbError) {
    console.error('[GitHub Callback] DB error:', dbError);
    return NextResponse.redirect(
      new URL(`${returnUrl}?error=db_error&message=${encodeURIComponent(String(dbError))}`, req.url)
    );
  }

  // Sync repositories
  try {
    await syncInstallationRepos(installationDbId, parseInt(installationId));
    console.log('[GitHub Callback] Repos synced');
  } catch (error) {
    console.error('[GitHub Callback] Failed to sync repos:', error);
    // Don't fail the whole flow, repos can be synced later
  }

  console.log('[GitHub Callback] Success, redirecting to:', returnUrl);
  return NextResponse.redirect(
    new URL(`${returnUrl}?github_connected=true&org=${installation.account.login}`, req.url)
  );
}

// Helper function to generate JWT (duplicated from github.ts to avoid circular imports in Edge)
async function generateAppJWT(): Promise<string> {
  const GITHUB_APP_ID = process.env.GITHUB_APP_ID;

  // Support both base64-encoded key (preferred for Vercel) and raw key with \n
  const base64Key = process.env.GITHUB_APP_PRIVATE_KEY_BASE64;
  const GITHUB_APP_PRIVATE_KEY = base64Key
    ? Buffer.from(base64Key, 'base64').toString('utf-8')
    : process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
    throw new Error('GitHub App not configured');
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,
    exp: now + 600,
    iss: GITHUB_APP_ID,
  };

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
