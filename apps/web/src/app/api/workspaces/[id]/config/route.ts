import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, type WorkspaceGitConfig, type WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess } from '@/lib/team-access';

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
            const rc = body.releaseConfig;
            let releaseConfig: WorkspaceReleaseConfig | null = null;
            if (rc && typeof rc === 'object') {
                releaseConfig = {
                    enabled: Boolean(rc.enabled ?? true),
                    ...(typeof rc.strategy === 'string' ? { strategy: rc.strategy } : {}),
                    // workflow_dispatch
                    ...(typeof rc.workflowFile === 'string' ? { workflowFile: rc.workflowFile } : {}),
                    ...(typeof rc.ref === 'string' ? { ref: rc.ref } : {}),
                    ...(rc.inputs && typeof rc.inputs === 'object' ? { inputs: rc.inputs } : {}),
                    // branch_merge
                    ...(typeof rc.prodBranch === 'string' ? { prodBranch: rc.prodBranch } : {}),
                    ...(rc.deployTarget && rc.deployTarget.type === 'vercel'
                        ? { deployTarget: { type: 'vercel', projectId: rc.deployTarget.projectId, teamId: rc.deployTarget.teamId } }
                        : {}),
                    ...(Array.isArray(rc.postDeployHooks) ? { postDeployHooks: rc.postDeployHooks } : {}),
                    ...(typeof rc.verificationUrl === 'string' ? { verificationUrl: rc.verificationUrl } : {}),
                    // script
                    ...(typeof rc.command === 'string' ? { command: rc.command } : {}),
                };
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
