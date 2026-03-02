import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';

/**
 * GET /api/workers/[id]/sessions
 *
 * Proxies to runner's sessions endpoint which calls the SDK's
 * listSessions() and getSessionMessages() APIs.
 *
 * Query params:
 * - sessionId: If provided, fetches messages for that session
 * - limit: Page size for messages (default 50)
 * - offset: Offset for message pagination (default 0)
 *
 * Supports dual auth: API key (Bearer) or session cookie.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Dual auth: API key or session
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  let authorized = false;

  if (account) {
    // API key auth: verify worker belongs to this account
    const worker = await db.query.workers.findFirst({
      where: eq(workers.id, id),
      columns: { id: true, accountId: true, localUiUrl: true, workspaceId: true },
    });
    if (!worker) {
      return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    }
    if (worker.accountId !== account.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    authorized = true;
  } else {
    // Session auth: verify workspace access
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const worker = await db.query.workers.findFirst({
      where: eq(workers.id, id),
      columns: { id: true, workspaceId: true, localUiUrl: true },
    });
    if (!worker) {
      return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    }
    const access = await verifyWorkspaceAccess(user.id, worker.workspaceId);
    if (!access) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    authorized = true;
  }

  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Fetch worker to get localUiUrl for proxying
  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    columns: { id: true, localUiUrl: true },
  });

  if (!worker?.localUiUrl) {
    return NextResponse.json(
      { error: 'Worker has no runner URL — session history requires a direct connection' },
      { status: 404 }
    );
  }

  // Proxy the request to runner
  const url = new URL(req.url);
  const proxyUrl = new URL(`/api/workers/${id}/sessions`, worker.localUiUrl);

  // Forward query params
  const sessionId = url.searchParams.get('sessionId');
  if (sessionId) proxyUrl.searchParams.set('sessionId', sessionId);

  const limit = url.searchParams.get('limit');
  if (limit) proxyUrl.searchParams.set('limit', limit);

  const offset = url.searchParams.get('offset');
  if (offset) proxyUrl.searchParams.set('offset', offset);

  try {
    const res = await fetch(proxyUrl.toString(), {
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Failed to reach runner: ' + (err.message || 'connection refused') },
      { status: 502 }
    );
  }
}
