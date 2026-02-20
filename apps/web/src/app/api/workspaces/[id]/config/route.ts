import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, type WorkspaceGitConfig } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';

// GET /api/workspaces/[id]/config - Get workspace git config
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    // In development, allow without auth for local-ui
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
            },
        });

        if (!workspace) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }

        return NextResponse.json({
            gitConfig: workspace.gitConfig,
            configStatus: workspace.configStatus,
        });
    } catch (error) {
        console.error('Get workspace config error:', error);
        return NextResponse.json({ error: 'Failed to get config' }, { status: 500 });
    }
}

// POST /api/workspaces/[id]/config - Save workspace git config
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    const user = await getCurrentUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const access = await verifyWorkspaceAccess(user.id, id);
        if (!access) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }

        const body = await req.json();
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

            // Agent instructions
            agentInstructions: body.agentInstructions || undefined,
            useClaudeMd: body.useClaudeMd ?? true,

            // Permission mode
            bypassPermissions: body.bypassPermissions ?? false,

            // Remote skill installation allowlist
            ...(Array.isArray(body.skillInstallerAllowlist)
                ? { skillInstallerAllowlist: body.skillInstallerAllowlist.filter((s: unknown) => typeof s === 'string' && (s as string).trim()) }
                : {}),

            // Plugin directories to load when workers start tasks
            ...(Array.isArray(body.pluginPaths)
                ? { pluginPaths: body.pluginPaths.filter((s: unknown) => typeof s === 'string' && (s as string).trim()) }
                : {}),

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
            ...(body.blockConfigChanges === true ? { blockConfigChanges: true } : {}),

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

            // Organizer agent configuration
            ...(body.organizer && typeof body.organizer === 'object'
                ? {
                    organizer: {
                        enabled: Boolean(body.organizer.enabled),
                        ...(typeof body.organizer.reviewWindowHours === 'number' && body.organizer.reviewWindowHours > 0
                            ? { reviewWindowHours: Math.min(body.organizer.reviewWindowHours, 168) }
                            : {}),
                        requirePR: body.organizer.requirePR ?? true,
                        requirePlanSummary: body.organizer.requirePlanSummary ?? true,
                        autoCreateFollowUp: body.organizer.autoCreateFollowUp ?? false,
                    },
                }
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
