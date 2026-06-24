import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { watchedProjects } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { runWatcherForProject } from '@/lib/health-watcher';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = await db.query.watchedProjects.findFirst({
    where: eq(watchedProjects.id, id),
  });
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  let authorized = false;
  if (apiKey) {
    const account = await authenticateApiKey(apiKey);
    if (account) authorized = await verifyAccountWorkspaceAccess(account.id, row.workspaceId, 'canCreate');
  } else {
    const user = await getCurrentUser();
    if (user) authorized = !!(await verifyWorkspaceAccess(user.id, row.workspaceId));
  }
  if (!authorized) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const result = await runWatcherForProject(id);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
