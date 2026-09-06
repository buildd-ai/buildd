import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, githubRepos } from '@buildd/core/db/schema';
import { eq, sql } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, getUserTeamIds } from '@/lib/team-access';
import { enqueueFullIngestJob } from '@/lib/knowledge-ingest';
import { normalizeRepoFullName, normalizedRepoSql } from '@/lib/repo-scope';
import { mergePolicySchema } from '@/lib/merge-policy';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ workspace: null });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const access = await verifyWorkspaceAccess(user.id, id);
    if (!access) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, id),
      with: {
        tasks: true,
        workers: true,
        githubRepo: true,
      },
    });

    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    return NextResponse.json({ workspace });
  } catch (error) {
    console.error('Get workspace error:', error);
    return NextResponse.json({ error: 'Failed to get workspace' }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ success: true });
  }

  // Support both session auth and API key auth
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);
  const user = await getCurrentUser();

  if (!apiAccount && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // For session auth, verify workspace access via team membership
    if (user && !apiAccount) {
      const access = await verifyWorkspaceAccess(user.id, id);
      if (!access) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
    }
    // For API key auth, verify workspace belongs to the API key's team or is open-access
    if (apiAccount) {
      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, id),
        columns: { teamId: true, accessMode: true },
      });
      if (!ws || (ws.teamId !== apiAccount.teamId && ws.accessMode !== 'open')) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
    }

    const body = await req.json();
    const {
      name, repo, repoUrl, localPath, defaultBranch, accessMode, dataClass, teamId,
      gitConfig, maxConcurrentTasks, connectorAdvisoryMode,
    } = body;

    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (teamId !== undefined) {
      if (user) {
        const userTeamIds = await getUserTeamIds(user.id);
        if (!userTeamIds.includes(teamId)) {
          return NextResponse.json({ error: 'You do not belong to the target team' }, { status: 403 });
        }
      }
      updates.teamId = teamId;
    }

    if (name !== undefined) updates.name = name;
    // Accept both "repo" and "repoUrl" for convenience
    const repoValue = repo ?? repoUrl;
    if (repoValue !== undefined) {
      // Store the canonical `owner/name` when we can parse one. Anything we
      // cannot parse is kept verbatim — the column's remaining job is
      // user-declared intent (a repo the App is not installed on, a non-GitHub
      // host), and destroying that would be worse than storing it unnormalized.
      updates.repo = normalizeRepoFullName(repoValue) ?? repoValue;
      // Auto-link GitHub repo: resolve owner/name and look it up in githubRepos.
      const fullName = normalizeRepoFullName(repoValue);
      if (fullName) {
        const ghRepo = await db.query.githubRepos.findFirst({
          // Normalized equality, not `ilike`: repo names may contain `_`,
          // which LIKE treats as a single-character wildcard, so `owner/my_app`
          // would also match `owner/myXapp`.
          where: sql`${normalizedRepoSql(githubRepos.fullName)} = ${fullName.toLowerCase()}`,
        });
        if (ghRepo) {
          updates.githubRepoId = ghRepo.id;
          updates.githubInstallationId = ghRepo.installationId;
        }
      }
    }
    // Accept both "localPath" and "defaultBranch" (localPath column stores the default branch)
    const branchValue = localPath ?? defaultBranch;
    if (branchValue !== undefined) updates.localPath = branchValue;
    if (accessMode !== undefined) updates.accessMode = accessMode;
    if (dataClass !== undefined && (dataClass === 'standard' || dataClass === 'sensitive')) {
      updates.dataClass = dataClass;
    }
    // Max parallel workers per repo-backed workspace (>= 1). Worktree isolation makes
    // parallel work safe; this just bounds branch fan-out. Clamp to a sane floor of 1.
    if (maxConcurrentTasks !== undefined && maxConcurrentTasks !== null) {
      const n = Math.floor(Number(maxConcurrentTasks));
      if (!Number.isNaN(n)) updates.maxConcurrentTasks = Math.max(1, n);
    }

    // Connector degraded mode (docs/design/connector-availability-degraded-mode.md
    // Phase 1: ship the machinery, opt in per workspace, default stays block).
    // This is the flag's only writer: with it, a task whose role names a failing
    // connector claims anyway and carries a degradedConnectors notice, instead of
    // being deferred until someone notices. Two backstops make opting in safe and
    // both are already shipped: a task may name `requiredConnectors`, whose
    // failure still blocks, and total degradation (every connector for the role
    // unavailable) holds the task regardless of this flag.
    //
    // Phase 2 — flipping the DEFAULT to advisory — is deliberately NOT done here.
    // That changes behaviour for every existing workspace and the design gates it
    // on Phase 1 running clean plus an audit of roles whose connectors are
    // genuinely load-bearing.
    //
    // Strict boolean: a coerced value would let the string "false" turn a claim
    // gate off.
    if (connectorAdvisoryMode !== undefined) {
      if (typeof connectorAdvisoryMode !== 'boolean') {
        return NextResponse.json(
          { error: 'connectorAdvisoryMode must be a boolean' },
          { status: 400 },
        );
      }
      updates.connectorAdvisoryMode = connectorAdvisoryMode;
    }

    // Partial gitConfig merge (e.g. { autoMergePR: true }). Reads the existing
    // gitConfig and shallow-merges the provided keys, so a one-flag update can't
    // clobber the rest of the config — unlike the form's full-rebuild POST.
    if (gitConfig !== undefined && gitConfig !== null && typeof gitConfig === 'object' && !Array.isArray(gitConfig)) {
      if ('mergePolicy' in gitConfig && gitConfig.mergePolicy != null) {
        const result = mergePolicySchema.safeParse(gitConfig.mergePolicy);
        if (!result.success) {
          const msg = result.error.issues[0]?.message ?? 'invalid';
          const path = result.error.issues[0]?.path.join('.') ?? '';
          return NextResponse.json(
            { error: `gitConfig.mergePolicy${path ? `.${path}` : ''}: ${msg}` },
            { status: 400 },
          );
        }
      }
      const current = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, id),
        columns: { gitConfig: true },
      });
      updates.gitConfig = { ...(current?.gitConfig ?? {}), ...gitConfig };
    }

    // Read current repo before updating — needed to detect a change for auto-ingestion.
    let previousRepo: string | null = null;
    if (repoValue !== undefined) {
      const current = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, id),
        columns: { repo: true },
      });
      previousRepo = current?.repo ?? null;
    }

    await db.update(workspaces).set(updates).where(eq(workspaces.id, id));

    // Auto-ingest on repo link: enqueue a full job when repoUrl changes (spec §1.1).
    if (repoValue !== undefined && repoValue !== null && repoValue !== previousRepo) {
      const fullName = normalizeRepoFullName(repoValue);
      if (fullName) {
        enqueueFullIngestJob({ workspaceId: id, repo: fullName, trigger: 'repo_link' }).catch(err =>
          console.error(`[knowledge-ingest] repo-link enqueue failed for workspace ${id}:`, err)
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Update workspace error:', error);
    return NextResponse.json({ error: 'Failed to update workspace' }, { status: 500 });
  }
}


export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ success: true });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const access = await verifyWorkspaceAccess(user.id, id, 'owner');
    if (!access) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    // Delete the workspace (cascade will handle tasks, workers, etc.)
    await db.delete(workspaces).where(eq(workspaces.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete workspace error:', error);
    return NextResponse.json({ error: 'Failed to delete workspace' }, { status: 500 });
  }
}
