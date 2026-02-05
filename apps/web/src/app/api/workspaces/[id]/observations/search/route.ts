import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { observations, accounts } from '@buildd/core/db/schema';
import { eq, and, desc, or, ilike, sql, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';

const VALID_TYPES = ['discovery', 'decision', 'gotcha', 'pattern', 'architecture', 'summary'] as const;

async function authenticateRequest(req: NextRequest) {
    const authHeader = req.headers.get('authorization');
    const apiKey = authHeader?.replace('Bearer ', '') || null;

    if (apiKey) {
        const account = await db.query.accounts.findFirst({
            where: eq(accounts.apiKey, apiKey),
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

// GET /api/workspaces/[id]/observations/search
// Returns compact index format for progressive disclosure
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
        const query = url.searchParams.get('query');
        const type = url.searchParams.get('type');
        const filesParam = url.searchParams.get('files');
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '10'), 50);
        const offset = parseInt(url.searchParams.get('offset') || '0');

        const conditions = [eq(observations.workspaceId, id)];

        // Type filter
        if (type && VALID_TYPES.includes(type as any)) {
            conditions.push(eq(observations.type, type as typeof VALID_TYPES[number]));
        }

        // Text search on title and content
        if (query) {
            conditions.push(
                or(
                    ilike(observations.title, `%${query}%`),
                    ilike(observations.content, `%${query}%`)
                )!
            );
        }

        // File path filter - matches observations that reference any of the specified files
        if (filesParam) {
            const files = filesParam.split(',').map(f => f.trim()).filter(Boolean);
            if (files.length > 0) {
                // Use JSON array contains for file matching
                const fileConditions = files.map(file =>
                    sql`${observations.files}::jsonb @> ${JSON.stringify([file])}::jsonb`
                );
                conditions.push(or(...fileConditions)!);
            }
        }

        // Get total count for pagination
        const [countResult] = await db
            .select({ count: sql<number>`count(*)` })
            .from(observations)
            .where(and(...conditions));

        // Get results with only index fields (compact format)
        const results = await db
            .select({
                id: observations.id,
                title: observations.title,
                type: observations.type,
                files: observations.files,
                concepts: observations.concepts,
                createdAt: observations.createdAt,
            })
            .from(observations)
            .where(and(...conditions))
            .orderBy(desc(observations.createdAt))
            .limit(limit)
            .offset(offset);

        return NextResponse.json({
            results,
            total: Number(countResult.count),
            limit,
            offset,
        });
    } catch (error) {
        console.error('Search observations error:', error);
        return NextResponse.json({ error: 'Failed to search observations' }, { status: 500 });
    }
}
