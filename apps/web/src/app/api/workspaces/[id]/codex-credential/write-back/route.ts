import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, workers } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { writeBackCodexTokens } from '@/lib/codex-credential';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/workspaces/[id]/codex-credential/write-back
 *
 * Runner-only endpoint (API key auth). After a Codex session completes, the
 * runner reads the refreshed auth.json from the stable CODEX_HOME and POSTs
 * the tokens here so future workers start with current tokens rather than the
 * original stale snapshot. Implements the write-back half of the
 * "seed-if-missing + write-back" pattern from OpenAI's CI/CD auth guidance.
 *
 * Body: { accessToken, refreshToken, accountId?, expiresIn? }
 * Never logs token values.
 */
export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id } = await params;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }
  // Only workers (api key accounts) should call this — not trigger tokens.
  if (account.level === 'trigger') {
    return NextResponse.json({ error: 'Trigger tokens cannot write back credentials' }, { status: 403 });
  }

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
    columns: { id: true, teamId: true },
  });
  if (!workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  // The tokens are stored as the workspace team's credential. Accept them from
  // an account of that team, or from a runner account that has run a worker in
  // this workspace (the credential was leased to it at claim time).
  if (account.teamId !== workspace.teamId) {
    const ranHere = await db.query.workers.findFirst({
      where: and(eq(workers.accountId, account.id), eq(workers.workspaceId, id)),
      columns: { id: true },
    });
    if (!ranHere) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  if (typeof b.accessToken !== 'string' || typeof b.refreshToken !== 'string') {
    return NextResponse.json({ error: 'accessToken and refreshToken are required' }, { status: 400 });
  }

  const expiresIn = typeof b.expiresIn === 'number' ? b.expiresIn : undefined;
  const accountId = typeof b.accountId === 'string' ? b.accountId : undefined;
  const idToken = typeof b.idToken === 'string' ? b.idToken : undefined;

  try {
    await writeBackCodexTokens(
      { teamId: workspace.teamId, accountId: account.id, workspaceId: id },
      { accessToken: b.accessToken, refreshToken: b.refreshToken, accountId, idToken, expiresIn },
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[codex-write-back] Failed:', err instanceof Error ? err.message : 'unknown');
    return NextResponse.json({ error: 'Write-back failed' }, { status: 500 });
  }
}
