import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, type WorkspaceGitConfig, type WorkspaceReleaseConfig, type ReleaseTrigger, type ReleaseStrategy } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess } from '@/lib/team-access';

const VALID_STRATEGIES: ReleaseStrategy[] = ['workflow_dispatch', 'branch_merge', 'script'];
const VALID_TRIGGERS: ReleaseTrigger[] = ['every_merge', 'on_mission_complete', 'manual', 'scheduled'];

// Parse + validate the releaseConfig body fragment. Returns the sanitized config or
// a string error message the caller can surface to the UI.
function parseReleaseConfig(rc: unknown): { ok: true; config: WorkspaceReleaseConfig } | { ok: false; error: string; status: number } {
    if (!rc || typeof rc !== 'object') {
        return { ok: false, error: 'releaseConfig must be an object', status: 400 };
    }
    const r = rc as Record<string, unknown>;

    // Treat strategy='none' as disabled (convenience alias used by the UI selector)
    const strategyRaw = typeof r.strategy === 'string' ? r.strategy : undefined;
    if (strategyRaw === 'none') {
        return { ok: true, config: { enabled: false } };
    }
    if (strategyRaw !== undefined && !VALID_STRATEGIES.includes(strategyRaw as ReleaseStrategy)) {
        return { ok: false, error: `Invalid strategy '${strategyRaw}'. Valid: ${VALID_STRATEGIES.join(', ')}, none`, status: 422 };
    }
    const strategy = strategyRaw as ReleaseStrategy | undefined;

    const triggerRaw = typeof r.trigger === 'string' ? r.trigger : undefined;
    if (triggerRaw !== undefined && !VALID_TRIGGERS.includes(triggerRaw as ReleaseTrigger)) {
        return { ok: false, error: `Invalid trigger '${triggerRaw}'. Valid: ${VALID_TRIGGERS.join(', ')}`, status: 422 };
    }
    const trigger = triggerRaw as ReleaseTrigger | undefined;

    // strategy-specific field validation (only when strategy is being set)
    if (strategy === 'branch_merge') {
        if (r.prodBranch !== undefined && typeof r.prodBranch !== 'string') {
            return { ok: false, error: 'branch_merge: prodBranch must be a string', status: 422 };
        }
    }
    if (strategy === 'workflow_dispatch') {
        if (r.workflowFile !== undefined && typeof r.workflowFile !== 'string') {
            return { ok: false, error: 'workflow_dispatch: workflowFile must be a string', status: 422 };
        }
        if (r.ref !== undefined && typeof r.ref !== 'string') {
            return { ok: false, error: 'workflow_dispatch: ref must be a string', status: 422 };
        }
    }

    const config: WorkspaceReleaseConfig = {
        enabled: Boolean(r.enabled ?? true),
        ...(strategy ? { strategy } : {}),
        ...(trigger ? { trigger } : {}),
        // workflow_dispatch
        ...(typeof r.workflowFile === 'string' ? { workflowFile: r.workflowFile } : {}),
        ...(typeof r.ref === 'string' ? { ref: r.ref } : {}),
        ...(r.inputs && typeof r.inputs === 'object' ? { inputs: r.inputs as Record<string, string> } : {}),
        // branch_merge
        ...(typeof r.prodBranch === 'string' ? { prodBranch: r.prodBranch } : {}),
        ...(r.deployTarget && (r.deployTarget as any).type === 'vercel'
            ? { deployTarget: { type: 'vercel', projectId: (r.deployTarget as any).projectId, teamId: (r.deployTarget as any).teamId } }
            : {}),
        ...(Array.isArray(r.postDeployHooks) ? { postDeployHooks: r.postDeployHooks as WorkspaceReleaseConfig['postDeployHooks'] } : {}),
        ...(typeof r.verificationUrl === 'string' ? { verificationUrl: r.verificationUrl } : {}),
        // script
        ...(typeof r.command === 'string' ? { command: r.command } : {}),
    };

    return { ok: true, config };
}

// Resolve the requesting account for write operations.
// Returns { userId?, apiAccount? } — at least one will be set, or null if unauthorized.
async function resolveWriteAuth(req: NextRequest) {
    const authHeader = req.headers.get('authorization');
    const apiKey = authHeader?.replace('Bearer ', '') || null;
    const apiAccount = await authenticateApiKey(apiKey);
    const user = await getCurrentUser();
    if (!apiAccount && !user) return null;
    return { user, apiAccount };
}

// Verify that the requesting auth has write access to workspaceId.
async function verifyWriteAccess(auth: { user: any; apiAccount: any }, workspaceId: string): Promise<boolean> {
    const { user, apiAccount } = auth;
    if (user && !apiAccount) {
        const access = await verifyWorkspaceAccess(user.id, workspaceId);
        return Boolean(access);
    }
    if (apiAccount) {
        const ws = await db.query.workspaces.findFirst({
            where: eq(workspaces.id, workspaceId),
            columns: { teamId: true, accessMode: true },
        });
        return Boolean(ws && (ws.teamId === apiAccount.teamId || ws.accessMode === 'open'));
    }
    return false;
}

// GET /api/workspaces/[id]/config - Get workspace git config
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    // In development, allow without auth for runner
    const authHeader = req.headers.get('authorization');
    const isApiAuth = authHeader?.startsWith('Bearer ');

    if (!isApiAuth && process.env.NODE_ENV !== 'development') {
        const user = await getCurrentUser();
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
    }

    try {
        const workspace = await db.query.workspaces.findFirst({
            where: eq(workspaces.id, id),
            columns: {
                id: true,
                name: true,
                gitConfig: true,
                configStatus: true,
                releaseConfig: true,
            },
        });

        if (!workspace) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }

        return NextResponse.json({
            gitConfig: workspace.gitConfig,
            configStatus: workspace.configStatus,
            releaseConfig: workspace.releaseConfig ?? null,
        });
    } catch (error) {
        console.error('Get workspace config error:', error);
        return NextResponse.json({ error: 'Failed to get config' }, { status: 500 });
    }
}

// POST /api/workspaces/[id]/config - Save workspace git config and/or releaseConfig
//
// releaseConfig schema (WorkspaceReleaseConfig):
//   enabled: boolean                    — whether this workspace releases at all
//   strategy?: 'workflow_dispatch'      — dispatch the repo's own GitHub Actions workflow
//            | 'branch_merge'           — merge source branch into prodBranch on task completion
//            | 'script'                 — run command in a spawned worker (not yet implemented)
//
//   workflow_dispatch fields:
//     workflowFile?: string             — e.g. "release.yml"
//     ref?: string                      — source branch the workflow runs on, e.g. "dev"
//     inputs?: Record<string, string>   — extra workflow_dispatch inputs
//
//   branch_merge fields:
//     prodBranch?: string               — production branch to merge into, e.g. "main"
//     deployTarget?: { type: 'vercel', projectId?: string, teamId?: string }
//     verificationUrl?: string          — URL polled after deploy to confirm health (expects 2xx)
//     postDeployHooks?: Array<{         — run after successful deploy confirmation
//       type: 'buildd_mcp' | 'http'
//       description: string
//       action?: string                 — buildd_mcp: tool action name
//       params?: Record<string,unknown> — buildd_mcp: params
//       url?: string                    — http: POST target
//       headers?: Record<string,string> — http: extra headers
//     }>
//
//   script fields:
//     command?: string                  — e.g. "bun run release"
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    // Support both session auth and API key/OAuth auth
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
        // For API key/OAuth auth, verify workspace belongs to the key's team
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

        // Handle releaseConfig update if provided (separate from gitConfig)
        if (body.releaseConfig !== undefined) {
            let releaseConfig: WorkspaceReleaseConfig | null = null;
            if (body.releaseConfig && typeof body.releaseConfig === 'object') {
                const parsed = parseReleaseConfig(body.releaseConfig);
                if (!parsed.ok) {
                    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
                }
                releaseConfig = parsed.config;
            }
            await db
                .update(workspaces)
                .set({ releaseConfig, updatedAt: new Date() })
                .where(eq(workspaces.id, id));

            // If only releaseConfig was provided, return early
            if (!body.defaultBranch && !body.branchingStrategy && !body.commitStyle && !body.requiresPR) {
                return NextResponse.json({ success: true, releaseConfig });
            }
        }

        const gitConfig: WorkspaceGitConfig = {
            // Branching (required)
            defaultBranch: body.defaultBranch || 'main',
            branchingStrategy: body.branchingStrategy || 'feature',
            branchPrefix: body.branchPrefix || undefined,
            useBuildBranch: body.useBuildBranch || false,

            // Commit conventions
            commitStyle: body.commitStyle || 'freeform',
            commitPrefix: body.commitPrefix || undefined,

            // PR/Merge behavior
            requiresPR: body.requiresPR ?? false,
            targetBranch: body.targetBranch || undefined,
            autoCreatePR: body.autoCreatePR ?? false,
            autoMergeOnGreenCI: body.autoMergeOnGreenCI ?? true,
            // Keep legacy field in sync so old readers still work
            autoMergePR: body.autoMergeOnGreenCI ?? body.autoMergePR ?? false,
            // Safety rails for autoMergeOnGreenCI (optional; not yet surfaced in the form
            // but accepted here so they can be configured via the API).
            ...(Array.isArray(body.autoMergeDenyPaths)
                ? { autoMergeDenyPaths: body.autoMergeDenyPaths.filter((p: unknown) => typeof p === 'string') }
                : {}),
            ...(typeof body.autoMergeMaxLines === 'number' && body.autoMergeMaxLines > 0
                ? { autoMergeMaxLines: body.autoMergeMaxLines }
                : {}),

            // Agent instructions
            agentInstructions: body.agentInstructions || undefined,
            useClaudeMd: body.useClaudeMd ?? true,

            // Permission mode
            bypassPermissions: body.bypassPermissions ?? false,

            // Max budget per worker session (SDK-enforced)
            ...(typeof body.maxBudgetUsd === 'number' && body.maxBudgetUsd > 0
                ? { maxBudgetUsd: body.maxBudgetUsd }
                : {}),

            // SDK debug logging
            ...(body.debug === true ? { debug: true } : {}),
            ...(typeof body.debugFile === 'string' && body.debugFile.trim()
                ? { debugFile: body.debugFile.trim() }
                : {}),

            // Sandbox configuration for worker isolation
            ...(body.sandbox && typeof body.sandbox === 'object'
                ? {
                    sandbox: {
                        enabled: Boolean(body.sandbox.enabled),
                        autoAllowBashIfSandboxed: Boolean(body.sandbox.autoAllowBashIfSandboxed),
                        ...(body.sandbox.network && typeof body.sandbox.network === 'object'
                            ? {
                                network: {
                                    ...(Array.isArray(body.sandbox.network.allowedDomains)
                                        ? { allowedDomains: body.sandbox.network.allowedDomains.filter((s: unknown) => typeof s === 'string' && (s as string).trim()) }
                                        : {}),
                                    allowLocalBinding: Boolean(body.sandbox.network.allowLocalBinding),
                                },
                            }
                            : {}),
                        ...(Array.isArray(body.sandbox.excludedCommands)
                            ? { excludedCommands: body.sandbox.excludedCommands.filter((s: unknown) => typeof s === 'string' && (s as string).trim()) }
                            : {}),
                    },
                }
                : {}),

            // Block config file changes during worker sessions (ConfigChange hook)
            ...(typeof body.blockConfigChanges === 'boolean' ? { blockConfigChanges: body.blockConfigChanges } : {}),

            // Background agents (SDK v0.2.49+) — subagents run as background tasks
            ...(typeof body.useBackgroundAgents === 'boolean'
                ? { useBackgroundAgents: body.useBackgroundAgents }
                : {}),

            // Fallback model (SDK v0.2.45+)
            ...(typeof body.fallbackModel === 'string' && body.fallbackModel.trim()
                ? { fallbackModel: body.fallbackModel.trim() }
                : {}),

            // 1M context window beta
            ...(typeof body.extendedContext === 'boolean'
                ? { extendedContext: body.extendedContext }
                : {}),

            // Thinking / effort controls (SDK v0.2.45+)
            ...(body.thinking && typeof body.thinking === 'object' && body.thinking.type
                ? { thinking: body.thinking }
                : {}),
            ...(typeof body.effort === 'string' && ['low', 'medium', 'high', 'max'].includes(body.effort)
                ? { effort: body.effort }
                : {}),

            // Default runner preference for new tasks
            ...(typeof body.defaultRunnerPreference === 'string' && ['any', 'user', 'service', 'action'].includes(body.defaultRunnerPreference)
                ? { defaultRunnerPreference: body.defaultRunnerPreference }
                : {}),

        };

        await db
            .update(workspaces)
            .set({
                gitConfig,
                configStatus: 'admin_confirmed',
                updatedAt: new Date(),
            })
            .where(eq(workspaces.id, id));

        return NextResponse.json({ success: true, gitConfig });
    } catch (error) {
        console.error('Save workspace config error:', error);
        return NextResponse.json({ error: 'Failed to save config' }, { status: 500 });
    }
}

// PATCH /api/workspaces/[id]/config — partial releaseConfig update
//
// Accepts only { releaseConfig: Partial<WorkspaceReleaseConfig> }. Use POST for
// gitConfig changes. PATCH is the preferred endpoint for the Release UI section.
//
// strategy='none' disables releases (sets enabled:false, clears strategy fields).
// trigger validation enforces the ReleaseTrigger enum.
// branch_merge: prodBranch must be a string if provided.
// workflow_dispatch: workflowFile + ref must be strings if provided.
export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    const auth = await resolveWriteAuth(req);
    if (!auth) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const hasAccess = await verifyWriteAccess(auth, id);
        if (!hasAccess) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }

        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
        }

        if (!body || typeof body !== 'object' || !('releaseConfig' in body)) {
            return NextResponse.json({ error: 'Body must contain releaseConfig' }, { status: 400 });
        }

        const rc = (body as Record<string, unknown>).releaseConfig;

        // null / explicit null disables releases
        if (rc === null) {
            await db.update(workspaces).set({ releaseConfig: null, updatedAt: new Date() }).where(eq(workspaces.id, id));
            return NextResponse.json({ success: true, releaseConfig: null });
        }

        const parsed = parseReleaseConfig(rc);
        if (!parsed.ok) {
            return NextResponse.json({ error: parsed.error }, { status: parsed.status });
        }

        await db
            .update(workspaces)
            .set({ releaseConfig: parsed.config, updatedAt: new Date() })
            .where(eq(workspaces.id, id));

        return NextResponse.json({ success: true, releaseConfig: parsed.config });
    } catch (error) {
        console.error('PATCH workspace config error:', error);
        return NextResponse.json({ error: 'Failed to save config' }, { status: 500 });
    }
}
