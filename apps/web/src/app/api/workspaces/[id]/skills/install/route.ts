import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaceSkills, accounts } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { validateInstallerCommand, type SkillInstallPayload, type SkillBundle } from '@buildd/shared';

async function authenticateRequest(req: NextRequest) {
    const authHeader = req.headers.get('authorization');
    const apiKey = authHeader?.replace('Bearer ', '') || null;

    if (apiKey) {
        const account = await db.query.accounts.findFirst({
            where: eq(accounts.apiKey, hashApiKey(apiKey)),
        });
        if (account) return { type: 'api' as const, account };
    }

    if (process.env.NODE_ENV !== 'development') {
        const user = await getCurrentUser();
        if (user) return { type: 'session' as const, user };
    } else {
        return { type: 'dev' as const };
    }

    return null;
}

// POST /api/workspaces/[id]/skills/install — trigger remote skill installation
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const auth = await authenticateRequest(req);
    if (!auth) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Verify workspace access
    if (auth.type === 'api') {
        const hasAccess = await verifyAccountWorkspaceAccess(auth.account.id, id);
        if (!hasAccess) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }
    } else if (auth.type === 'session') {
        const access = await verifyWorkspaceAccess(auth.user.id, id);
        if (!access) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }
    }

    const body = await req.json();
    const { skillId, installerCommand, targetLocalUiUrl } = body;

    if (!skillId && !installerCommand) {
        return NextResponse.json({ error: 'Either skillId or installerCommand is required' }, { status: 400 });
    }

    if (skillId && installerCommand) {
        return NextResponse.json({ error: 'Provide skillId or installerCommand, not both' }, { status: 400 });
    }

    const requestId = crypto.randomUUID();
    let payload: SkillInstallPayload;

    if (skillId) {
        // Content push: look up workspace skill and build bundle
        const skill = await db.query.workspaceSkills.findFirst({
            where: and(
                eq(workspaceSkills.workspaceId, id),
                eq(workspaceSkills.id, skillId),
            ),
        });

        if (!skill) {
            return NextResponse.json({ error: 'Skill not found in workspace' }, { status: 404 });
        }

        const bundle: SkillBundle = {
            slug: skill.slug,
            name: skill.name,
            description: skill.description || undefined,
            content: skill.content,
            contentHash: skill.contentHash,
            referenceFiles: (skill.metadata as any)?.referenceFiles,
        };

        payload = {
            requestId,
            skillSlug: skill.slug,
            bundle,
            targetLocalUiUrl: targetLocalUiUrl || null,
        };
    } else {
        // Command execution: validate against default allowlist
        const validation = validateInstallerCommand(installerCommand, {});

        if (!validation.allowed) {
            return NextResponse.json({ error: validation.reason }, { status: 403 });
        }

        // Extract slug from command (best effort: last segment)
        const parts = installerCommand.trim().split(/\s+/);
        const skillSlug = parts[parts.length - 1]?.split('/').pop() || 'unknown';

        payload = {
            requestId,
            skillSlug,
            installerCommand,
            targetLocalUiUrl: targetLocalUiUrl || null,
        };
    }

    // Send via Pusher to all workers on this workspace
    await triggerEvent(channels.workspace(id), events.SKILL_INSTALL, payload);

    return NextResponse.json({ requestId, ok: true });
}
