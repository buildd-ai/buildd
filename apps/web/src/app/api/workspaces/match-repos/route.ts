import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, githubInstallations, accountWorkspaces } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserWorkspaceIds, getUserTeamIds } from '@/lib/team-access';

interface RepoDescriptor {
  path: string;
  remoteUrl: string | null;
  owner: string | null;
  repo: string | null;
  provider: string | null;
}

interface MatchedRepo extends RepoDescriptor {
  workspaceId: string;
  workspaceName: string;
}

interface UnmatchedRepo extends RepoDescriptor {
  inOrg: boolean;
}

/**
 * POST /api/workspaces/match-repos
 *
 * Takes an array of locally detected repos and matches them against
 * existing workspaces and GitHub org memberships.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { repos } = body as { repos: RepoDescriptor[] };

    if (!Array.isArray(repos)) {
      return NextResponse.json({ error: 'repos array required' }, { status: 400 });
    }

    // Limit to prevent abuse
    const limitedRepos = repos.slice(0, 100);

    // Get workspaces accessible to this account
    const accountWs = await db.query.accountWorkspaces.findMany({
      where: eq(accountWorkspaces.accountId, account.id),
      with: { workspace: true },
    });

    // Also get open workspaces
    const openWorkspaces = await db.query.workspaces.findMany({
      where: eq(workspaces.accessMode, 'open'),
      limit: 200,
    });

    // Combine into a deduplicated list
    const allWorkspaces = new Map<string, typeof workspaces.$inferSelect>();
    for (const aw of accountWs) {
      if (aw.workspace) allWorkspaces.set(aw.workspace.id, aw.workspace);
    }
    for (const ws of openWorkspaces) {
      allWorkspaces.set(ws.id, ws);
    }

    // Normalize repo URLs for comparison
    const normalizeUrl = (url: string | null | undefined): string | null => {
      if (!url) return null;
      return url
        .toLowerCase()
        .replace(/\.git$/, '')
        .replace(/^https?:\/\/[^/]+\//, '')
        .replace(/^git@[^:]+:/, '');
    };

    // Build lookup: normalized URL -> workspace
    const urlToWorkspace = new Map<string, { id: string; name: string }>();
    for (const ws of allWorkspaces.values()) {
      const normalized = normalizeUrl(ws.repo);
      if (normalized) {
        urlToWorkspace.set(normalized, { id: ws.id, name: ws.name });
      }
    }

    // Get GitHub org logins from installations associated with this account's team
    const orgLogins = new Set<string>();
    try {
      const installations = await db.query.githubInstallations.findMany({
        columns: { accountLogin: true },
      });
      for (const inst of installations) {
        orgLogins.add(inst.accountLogin.toLowerCase());
      }
    } catch {
      // Non-fatal - just can't check org membership
    }

    // Match repos
    const matched: MatchedRepo[] = [];
    const unmatchedInOrg: UnmatchedRepo[] = [];
    const unmatchedExternal: UnmatchedRepo[] = [];

    for (const repo of limitedRepos) {
      const normalized = normalizeUrl(repo.remoteUrl);

      // Check if this repo matches an existing workspace
      const ws = normalized ? urlToWorkspace.get(normalized) : null;

      if (ws) {
        matched.push({
          ...repo,
          workspaceId: ws.id,
          workspaceName: ws.name,
        });
      } else if (repo.owner && orgLogins.has(repo.owner.toLowerCase())) {
        unmatchedInOrg.push({ ...repo, inOrg: true });
      } else {
        unmatchedExternal.push({ ...repo, inOrg: false });
      }
    }

    return NextResponse.json({
      matched,
      unmatchedInOrg,
      unmatchedExternal,
    });
  } catch (error) {
    console.error('Match repos error:', error);
    return NextResponse.json({ error: 'Failed to match repos' }, { status: 500 });
  }
}
