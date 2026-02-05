import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { observations, accounts } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';

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

// GET /api/workspaces/[id]/observations/batch
// Returns full observation details for specified IDs
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const auth = await authenticateRequest(req);
    if (!auth) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const url = new URL(req.url);
        const idsParam = url.searchParams.get('ids');

        if (!idsParam) {
            return NextResponse.json({ error: 'ids parameter is required' }, { status: 400 });
        }

        const ids = idsParam.split(',').map(id => id.trim()).filter(Boolean);

        if (ids.length === 0) {
            return NextResponse.json({ observations: [] });
        }

        if (ids.length > 20) {
            return NextResponse.json({ error: 'Maximum 20 IDs per request' }, { status: 400 });
        }

        // Validate UUID format
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const invalidIds = ids.filter(id => !uuidRegex.test(id));
        if (invalidIds.length > 0) {
            return NextResponse.json({ error: `Invalid UUID format: ${invalidIds.join(', ')}` }, { status: 400 });
        }

        // Get full observation details, but only for this workspace
        const results = await db
            .select()
            .from(observations)
            .where(
                and(
                    eq(observations.workspaceId, id),
                    inArray(observations.id, ids)
                )
            );

        return NextResponse.json({ observations: results });
    } catch (error) {
        console.error('Batch get observations error:', error);
        return NextResponse.json({ error: 'Failed to get observations' }, { status: 500 });
    }
}
