import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';

// POST /api/workspaces/[id]/webhook/test - Test webhook connectivity
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
        // Verify ownership
        const workspace = await db.query.workspaces.findFirst({
            where: and(eq(workspaces.id, id), eq(workspaces.ownerId, user.id)),
            columns: { id: true },
        });

        if (!workspace) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }

        const { url, token } = await req.json();
        if (!url) {
            return NextResponse.json({ error: 'URL is required' }, { status: 400 });
        }

        // Send a test wake event (lightweight, won't trigger agent work)
        const response = await fetch(url.replace('/hooks/agent', '/hooks/wake'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token && { Authorization: `Bearer ${token}` }),
            },
            body: JSON.stringify({
                text: 'Buildd webhook test - connection verified',
                mode: 'next-heartbeat',
            }),
            signal: AbortSignal.timeout(5000),
        });

        if (response.ok) {
            return NextResponse.json({ message: 'Connection successful' });
        }

        if (response.status === 401) {
            return NextResponse.json({ message: 'Authentication failed - check your token' }, { status: 400 });
        }

        return NextResponse.json(
            { message: `Webhook returned ${response.status}` },
            { status: 400 }
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        if (message.includes('timeout') || message.includes('abort')) {
            return NextResponse.json({ message: 'Connection timed out (5s)' }, { status: 400 });
        }
        if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
            return NextResponse.json({ message: 'Connection refused - is the agent running?' }, { status: 400 });
        }
        return NextResponse.json({ message: `Connection failed: ${message}` }, { status: 400 });
    }
}
