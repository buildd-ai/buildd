import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { observations, accounts } from '@buildd/core/db/schema';
import { eq, desc } from 'drizzle-orm';
import { hashApiKey } from '@/lib/api-auth';
import { verifyAccountWorkspaceAccess } from '@/lib/team-access';

// GET /api/workspaces/[id]/observations/compact
// Returns observations formatted as markdown for prompt injection
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    // Auth: API key or dev mode
    const authHeader = req.headers.get('authorization');
    const apiKey = authHeader?.replace('Bearer ', '') || null;

    if (apiKey) {
        const account = await db.query.accounts.findFirst({
            where: eq(accounts.apiKey, hashApiKey(apiKey)),
        });
        if (!account) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        // Verify workspace access for API key
        const hasAccess = await verifyAccountWorkspaceAccess(account.id, id);
        if (!hasAccess) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }
    } else if (process.env.NODE_ENV !== 'development') {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const results = await db
            .select()
            .from(observations)
            .where(eq(observations.workspaceId, id))
            .orderBy(desc(observations.createdAt))
            .limit(50);

        if (results.length === 0) {
            return NextResponse.json({ markdown: '', count: 0 });
        }

        // Group by type
        const grouped: Record<string, typeof results> = {};
        for (const obs of results) {
            if (!grouped[obs.type]) grouped[obs.type] = [];
            grouped[obs.type].push(obs);
        }

        // Type display order and labels
        const typeOrder = [
            ['gotcha', 'Gotchas'],
            ['architecture', 'Architecture'],
            ['pattern', 'Patterns'],
            ['decision', 'Decisions'],
            ['discovery', 'Discoveries'],
            ['summary', 'Task Summaries'],
        ] as const;

        const sections: string[] = [];
        sections.push(`## Workspace Memory (${results.length} observations)\n`);

        for (const [type, label] of typeOrder) {
            const items = grouped[type];
            if (!items || items.length === 0) continue;

            sections.push(`### ${label}`);
            for (const obs of items) {
                // Truncate content to ~200 chars
                const truncated = obs.content.length > 200
                    ? obs.content.slice(0, 200) + '...'
                    : obs.content;
                const files = (obs.files as string[] || []);
                const fileStr = files.length > 0 ? ` (files: ${files.slice(0, 5).join(', ')})` : '';
                sections.push(`- **${obs.title}**: ${truncated}${fileStr}`);
            }
            sections.push('');
        }

        const markdown = sections.join('\n');

        // Ensure under ~16000 chars (~4000 tokens)
        const trimmed = markdown.length > 16000
            ? markdown.slice(0, 16000) + '\n\n*...truncated*'
            : markdown;

        return NextResponse.json({ markdown: trimmed, count: results.length });
    } catch (error) {
        console.error('Compact observations error:', error);
        return NextResponse.json({ error: 'Failed to get compact observations' }, { status: 500 });
    }
}
