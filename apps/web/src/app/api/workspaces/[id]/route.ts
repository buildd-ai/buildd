import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, githubRepos, type WorkspaceWebhookConfig } from '@buildd/core/db/schema';
import { eq, sql } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { roleHas } from '@/lib/permissions';
import { enqueueFullIngestJob } from '@/lib/knowledge-ingest';
import { normalizeRepoFullName, normalizedRepoSql } from '@/lib/repo-scope';
import { mergePolicySchema } from '@/lib/merge-policy';
import { findRemovedPathFieldInGitConfig, isWorkspaceExecutor, removedPolicyPathFieldError } from '@buildd/shared';
import { getInstallationOwnerTeamIds } from '@/lib/github-installation-access';
import { toPublicWorkspace } from '@/lib/workspace-public';
import { AGENT_GITHUB_CREDENTIALS_OPT_OUT } from '@buildd/core/agent-github-credentials';

const RUNNER_PREFERENCES = new Set(['any', 'user', 'service', 'action']);
const WEBHOOK_EVENTS = new Set(['task.created', 'task.unblocked', 'task.retry', 'task.resume', 'task.scheduled']);

/**
 * The `webhook_config` keys PATCH manages. The column also carries the issue
 * ingest keys (`webhookSecret`, `labelFilter`, ... read by
 * POST /api/webhooks/ingest); PATCH never writes or drops those.
 */
const DISPATCH_WEBHOOK_KEYS = ['url', 'token', 'enabled', 'runnerPreference', 'events'] as const;

/**
 * Plain http is accepted only for a dispatcher on the same machine or the
 * docker host (local development and apps/cloud-runner/scripts/local-e2e.sh).
 */
const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', 'host.docker.internal']);

/**
 * Validate a `webhookConfig` PATCH value and merge it onto what is stored.
 *
 *  - `null` removes the dispatch keys (the workspace goes back to
 *    Pusher-notified runners) and keeps every other key; the column becomes
 *    null only when nothing else is left.
 *  - An object must carry `url` and `enabled`; `token`, `runnerPreference`
 *    and `events` are optional, and a key the caller leaves out keeps its
 *    stored value. Unknown keys in the body are ignored.
 */
function parseWebhookConfigInput(
  raw: unknown,
  stored: unknown,
): { ok: true; value: WorkspaceWebhookConfig | null } | { ok: false; error: string } {
  const base: Record<string, unknown> =
    stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...(stored as Record<string, unknown>) } : {};

  if (raw === null) {
    for (const key of DISPATCH_WEBHOOK_KEYS) delete base[key];
    return { ok: true, value: Object.keys(base).length > 0 ? (base as unknown as WorkspaceWebhookConfig) : null };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'webhookConfig must be an object or null' };
  const c = raw as Record<string, unknown>;
  if (typeof c.url !== 'string') return { ok: false, error: 'webhookConfig.url is required' };
  let url: URL;
  try {
    url = new URL(c.url);
  } catch {
    return { ok: false, error: 'webhookConfig.url must be a valid URL' };
  }
  if (url.protocol === 'http:') {
    if (!LOCAL_HTTP_HOSTS.has(url.hostname)) {
      return { ok: false, error: `webhookConfig.url must be https (plain http only for ${[...LOCAL_HTTP_HOSTS].join(', ')})` };
    }
  } else if (url.protocol !== 'https:') {
    return { ok: false, error: 'webhookConfig.url must be http(s)' };
  }
  if (typeof c.enabled !== 'boolean') return { ok: false, error: 'webhookConfig.enabled must be a boolean' };
  if (c.token !== undefined && typeof c.token !== 'string') return { ok: false, error: 'webhookConfig.token must be a string' };
  if (c.runnerPreference !== undefined) {
    if (typeof c.runnerPreference !== 'string' || !RUNNER_PREFERENCES.has(c.runnerPreference)) {
      return { ok: false, error: `webhookConfig.runnerPreference must be one of: ${[...RUNNER_PREFERENCES].join(', ')}` };
    }
  }
  if (c.events !== undefined) {
    if (!Array.isArray(c.events) || !c.events.every((e) => typeof e === 'string' && WEBHOOK_EVENTS.has(e))) {
      return { ok: false, error: `webhookConfig.events must be an array of: ${[...WEBHOOK_EVENTS].join(', ')}` };
    }
  }

  const value: Record<string, unknown> = { ...base, url: c.url, enabled: c.enabled };
  if (c.token !== undefined) value.token = c.token;
  if (typeof value.token !== 'string') value.token = '';
  if (c.runnerPreference !== undefined) value.runnerPreference = c.runnerPreference;
  if (c.events !== undefined) value.events = [...new Set(c.events as string[])];
  if (value.enabled && !value.token) return { ok: false, error: 'webhookConfig.token is required when enabled' };
  return { ok: true, value: value as unknown as WorkspaceWebhookConfig };
}

/** Where a team change goes instead of PATCH: the checked move's dry run. */
const MOVE_PRECHECK_ENDPOINT = '/api/workspaces/[id]/migrate/precheck';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (process.env.NODE_ENV === 'development' && (!process.env.DATABASE_URL || !process.env.DEV_USER_EMAIL)) {
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

    // Allowlisted row (webhook_config.token masked) plus the loaded relations.
    const { tasks, workers, githubRepo } = workspace;
    return NextResponse.json({
      workspace: { ...toPublicWorkspace(workspace), tasks, workers, githubRepo },
    });
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
  const apiAccount = await authenticateApiKey(apiKey, req);
  const user = await getCurrentUser();

  if (!apiAccount && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // The workspace's current team — every check below is made against it.
    let workspaceTeamId: string | undefined;
    let sessionRole: string | undefined;
    // For session auth, verify workspace access via team membership
    if (user && !apiAccount) {
      const access = await verifyWorkspaceAccess(user.id, id);
      if (!access) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
      workspaceTeamId = access.teamId;
      sessionRole = access.role;
    }
    // For API key auth, the workspace must belong to the API key's own team.
    if (apiAccount) {
      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, id),
        columns: { teamId: true },
      });
      if (!ws || ws.teamId !== apiAccount.teamId) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
      workspaceTeamId = ws.teamId;
    }

    const body = await req.json();
    const {
      name, repo, repoUrl, localPath, defaultBranch, accessMode, dataClass,
      gitConfig, maxConcurrentTasks, connectorAdvisoryMode, webhookConfig,
    } = body;

    // A workspace changes team only through the checked move: POST
    // /migrate/precheck (dry run, signed token, admin on both teams) then POST
    // /migrate/execute. PATCH never writes teamId, for any caller or role, and
    // a body carrying it is refused whole so nothing else in it is applied.
    if (body && typeof body === 'object' && 'teamId' in body) {
      return NextResponse.json(
        {
          error: 'teamId cannot be changed here. Move a workspace to another team with '
            + 'POST /api/workspaces/[id]/migrate/precheck, then POST /api/workspaces/[id]/migrate/execute.',
          moveEndpoint: MOVE_PRECHECK_ENDPOINT,
        },
        { status: 400 },
      );
    }

    // Merge policy / git config, access mode, data class and the connector
    // claim gate are workspace-admin settings: owner or admin in the
    // workspace's team for a session (the bar POST /config sets for
    // sessions), plus an admin-level API key. Checked before any write so a
    // mixed body is all-or-nothing.
    // webhookConfig decides where the workspace's tasks are sent (and carries
    // the bearer token for it), so it is an admin setting too.
    const touchesAdminSettings = [gitConfig, accessMode, dataClass, connectorAdvisoryMode, webhookConfig]
      .some(v => v !== undefined);
    if (touchesAdminSettings) {
      const isAdmin = apiAccount
        ? hasTokenRouteAdminAccess(apiAccount, req)
        : roleHas(sessionRole, 'manage_workspace_settings');
      if (!isAdmin) {
        return NextResponse.json({ error: 'Requires workspace admin' }, { status: 403 });
      }
    }

    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (webhookConfig !== undefined) {
      const stored = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, id),
        columns: { webhookConfig: true },
      });
      const parsed = parseWebhookConfigInput(webhookConfig, stored?.webhookConfig ?? null);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      updates.webhookConfig = parsed.value;
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
        const candidates = await db.query.githubRepos.findMany({
          // Normalized equality, not `ilike`: repo names may contain `_`,
          // which LIKE treats as a single-character wildcard, so `owner/my_app`
          // would also match `owner/myXapp`.
          where: sql`${normalizedRepoSql(githubRepos.fullName)} = ${fullName.toLowerCase()}`,
        });
        // Link only through an installation that belongs to the workspace's
        // team (see lib/github-installation-access.ts). Otherwise the declared
        // repo is kept but left unlinked.
        for (const ghRepo of candidates) {
          const ownerTeamIds = await getInstallationOwnerTeamIds(ghRepo.installationId);
          if (workspaceTeamId && ownerTeamIds.includes(workspaceTeamId)) {
            updates.githubRepoId = ghRepo.id;
            updates.githubInstallationId = ghRepo.installationId;
            break;
          }
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
      // Hand-written merge-policy paths are refused; paths come from the repo scan.
      const removedField = findRemovedPathFieldInGitConfig(gitConfig, 'gitConfig');
      if (removedField) {
        return NextResponse.json(
          { error: removedPolicyPathFieldError(removedField), field: removedField },
          { status: 400 },
        );
      }
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
      // Path-claim enforcement opt-in: exact values only, so a truthy typo can
      // never quietly turn edit denial on (or appear to and not).
      if ('pathClaimEnforcement' in gitConfig) {
        const mode = (gitConfig as Record<string, unknown>).pathClaimEnforcement;
        if (mode !== null && mode !== 'advisory' && mode !== 'enforce') {
          return NextResponse.json(
            { error: "gitConfig.pathClaimEnforcement must be 'advisory', 'enforce' or null" },
            { status: 400 },
          );
        }
      }
      // Where the workspace's work runs: exact values only, so a typo can never
      // quietly reserve (or un-reserve) its tasks for a runner kind.
      if ('executor' in gitConfig) {
        const value = (gitConfig as Record<string, unknown>).executor;
        if (value !== null && !isWorkspaceExecutor(value)) {
          return NextResponse.json(
            { error: "gitConfig.executor must be 'cloud', 'host', 'any' or null" },
            { status: 400 },
          );
        }
      }
      // GitHub credentials opt-out for self-hosted agents: the one accepted
      // value is 'runner', so a typo cannot hand agents the operator's token.
      if ('agentGitHubCredentials' in gitConfig) {
        const mode = (gitConfig as Record<string, unknown>).agentGitHubCredentials;
        if (mode !== null && mode !== AGENT_GITHUB_CREDENTIALS_OPT_OUT) {
          return NextResponse.json(
            { error: `gitConfig.agentGitHubCredentials must be '${AGENT_GITHUB_CREDENTIALS_OPT_OUT}' or null` },
            { status: 400 },
          );
        }
      }
      // Surface merge ordering opt-in (conflict-aware-orchestration.md §3):
      // exact values only, and the per-surface flags must be what they claim.
      {
        const gc = gitConfig as Record<string, unknown>;
        if ('surfaceOrdering' in gc) {
          const mode = gc.surfaceOrdering;
          if (mode !== null && mode !== 'off' && mode !== 'shadow' && mode !== 'enforce') {
            return NextResponse.json(
              { error: "gitConfig.surfaceOrdering must be 'off', 'shadow', 'enforce' or null" },
              { status: 400 },
            );
          }
        }
        if ('semanticRefresh' in gc) {
          const mode = gc.semanticRefresh;
          if (mode !== null && mode !== 'off' && mode !== 'shadow' && mode !== 'enforce') {
            return NextResponse.json(
              { error: "gitConfig.semanticRefresh must be 'off', 'shadow', 'enforce' or null" },
              { status: 400 },
            );
          }
        }
        const badSerialize = (list: unknown) =>
          Array.isArray(list) && list.some((e) => e && typeof e === 'object' && 'serialize' in e && typeof (e as { serialize: unknown }).serialize !== 'boolean');
        const badTriggers = Array.isArray(gc.sequenceNamespaces) && (gc.sequenceNamespaces as unknown[]).some((e) => {
          const t = e && typeof e === 'object' ? (e as { triggers?: unknown }).triggers : undefined;
          return t !== undefined && (!Array.isArray(t) || t.some((x) => typeof x !== 'string' || !x));
        });
        if (badSerialize(gc.conflictSurfaces) || badSerialize(gc.sequenceNamespaces) || badTriggers) {
          return NextResponse.json(
            { error: 'gitConfig surfaces: serialize must be a boolean and sequenceNamespaces[].triggers a list of paths' },
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
    // A caller who may not delete it is told the workspace does not exist.
    const access = await verifyWorkspaceAccess(user.id, id);
    if (!access || !roleHas(access.role, 'delete_workspace')) {
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
