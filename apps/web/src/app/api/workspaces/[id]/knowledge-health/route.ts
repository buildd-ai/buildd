import { NextRequest, NextResponse } from 'next/server';
import { getKnowledgeHealth } from '@buildd/core/knowledge-store';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';

// Read-only. Workspace-scoped auth mirrors the skills route: OAuth/session users
// must be workspace members; API keys must belong to the workspace's team; dev
// mode is open (matches the sibling routes' local-dev convenience).
async function authenticateRequest(req: NextRequest) {
    const authHeader = req.headers.get('authorization');
    const apiKey = authHeader?.replace('Bearer ', '') || null;

    if (apiKey) {
        const account = await authenticateApiKey(apiKey);
        if (account) {
            return { type: 'api' as const, account };
        }
        // Invalid/unrecognized token — fall through to session auth.
    }

    if (process.env.NODE_ENV !== 'development') {
        const user = await getCurrentUser();
        if (user) return { type: 'session' as const, user };
    } else {
        return { type: 'dev' as const };
    }

    return null;
}

// GET /api/workspaces/[id]/knowledge-health
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const auth = await authenticateRequest(req);
    if (!auth) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (auth.type === 'session') {
        const access = await verifyWorkspaceAccess(auth.user.id, id);
        if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    } else if (auth.type === 'api') {
        const hasAccess = await verifyAccountWorkspaceAccess(auth.account.id, id);
        if (!hasAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    try {
        const health = await getKnowledgeHealth(id);
        return NextResponse.json({ health });
    } catch (error) {
        console.error('Knowledge health error:', error);
        return NextResponse.json({ error: 'Failed to load knowledge health' }, { status: 500 });
    }
}
