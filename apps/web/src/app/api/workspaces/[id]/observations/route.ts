import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { observations, workspaces, accounts } from '@buildd/core/db/schema';
import { eq, and, desc, or, ilike } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';

const VALID_TYPES = ['discovery', 'decision', 'gotcha', 'pattern', 'architecture', 'summary'] as const;

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

// GET /api/workspaces/[id]/observations
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const auth = await authenticateRequest(req);
    if (!auth) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Verify workspace access
    if (auth.type === 'session') {
        const access = await verifyWorkspaceAccess(auth.user.id, id);
        if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    } else if (auth.type === 'api') {
        const hasAccess = await verifyAccountWorkspaceAccess(auth.account.id, id);
        if (!hasAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    try {
        const url = new URL(req.url);
        const type = url.searchParams.get('type');
        const search = url.searchParams.get('search');
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
        const offset = parseInt(url.searchParams.get('offset') || '0');

        const conditions = [eq(observations.workspaceId, id)];

        if (type && VALID_TYPES.includes(type as any)) {
            conditions.push(eq(observations.type, type as typeof VALID_TYPES[number]));
        }

        if (search) {
            conditions.push(
                or(
                    ilike(observations.title, `%${search}%`),
                    ilike(observations.content, `%${search}%`)
                )!
            );
        }

        const results = await db
            .select()
            .from(observations)
            .where(and(...conditions))
            .orderBy(desc(observations.createdAt))
            .limit(limit)
            .offset(offset);

        return NextResponse.json({ observations: results });
    } catch (error) {
        console.error('Get observations error:', error);
        return NextResponse.json({ error: 'Failed to get observations' }, { status: 500 });
    }
}

// POST /api/workspaces/[id]/observations
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
    if (auth.type === 'session') {
        const access = await verifyWorkspaceAccess(auth.user.id, id);
        if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    } else if (auth.type === 'api') {
        const hasAccess = await verifyAccountWorkspaceAccess(auth.account.id, id);
        if (!hasAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    try {
        const body = await req.json();

        if (!body.type || !VALID_TYPES.includes(body.type)) {
            return NextResponse.json({ error: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}` }, { status: 400 });
        }
        if (!body.title || !body.content) {
            return NextResponse.json({ error: 'title and content are required' }, { status: 400 });
        }

        // Verify workspace exists
        const workspace = await db.query.workspaces.findFirst({
            where: eq(workspaces.id, id),
            columns: { id: true },
        });
        if (!workspace) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }

        const [observation] = await db.insert(observations).values({
            workspaceId: id,
            type: body.type,
            title: body.title,
            content: body.content,
            files: body.files || [],
            concepts: body.concepts || [],
            workerId: body.workerId || null,
            taskId: body.taskId || null,
        }).returning();

        return NextResponse.json({ observation }, { status: 201 });
    } catch (error) {
        console.error('Create observation error:', error);
        // Provide more helpful error message
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        const isDatabaseError = errorMsg.includes('constraint') || errorMsg.includes('foreign key');

        return NextResponse.json({
            error: 'Failed to create observation',
            detail: isDatabaseError ? 'Invalid reference (task or workspace may not exist)' : errorMsg.slice(0, 100)
        }, { status: 500 });
    }
}
