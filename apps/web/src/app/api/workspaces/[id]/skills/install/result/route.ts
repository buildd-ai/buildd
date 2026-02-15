import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { hashApiKey } from '@/lib/api-auth';
import { verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { triggerEvent, channels, events } from '@/lib/pusher';
import type { SkillInstallResult } from '@buildd/shared';

// POST /api/workspaces/[id]/skills/install/result — worker reports install result
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    // API key auth only (workers report results)
    const authHeader = req.headers.get('authorization');
    const apiKey = authHeader?.replace('Bearer ', '') || null;

    if (!apiKey) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const account = await db.query.accounts.findFirst({
        where: eq(accounts.apiKey, hashApiKey(apiKey)),
    });

    if (!account) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const hasAccess = await verifyAccountWorkspaceAccess(account.id, id);
    if (!hasAccess) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const body: SkillInstallResult = await req.json();

    if (!body.requestId || !body.skillSlug) {
        return NextResponse.json({ error: 'requestId and skillSlug are required' }, { status: 400 });
    }

    // Forward result via Pusher so dashboard can display per-worker status
    await triggerEvent(channels.workspace(id), events.SKILL_INSTALL_RESULT, body);

    return NextResponse.json({ ok: true });
}
