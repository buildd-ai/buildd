/** Internal admin read endpoint; no lifecycle hooks or public download links. */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { tokenWorkspaceAllowed } from '@buildd/core/token-scopes';
import { isTerminalWorkerStatus } from '@buildd/shared';
import { eq } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { isUuid } from '@/lib/uuid';
import { readCompletedSessionTranscript } from '@/lib/session-transcript';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  const { id } = await params;
  if (!isUuid(id)) return json({ error: 'Worker not found' }, 404);
  try {
    const account = await authenticateApiKey(req.headers.get('authorization')?.replace('Bearer ', '') || null, req);
    if (!account) return json({ error: 'Unauthorized' }, 401);
    if (account.level !== 'admin') return json({ error: 'Forbidden' }, 403);
    const worker = await db.query.workers.findFirst({
      where: eq(workers.id, id),
      columns: { id: true, accountId: true, workspaceId: true, status: true },
      with: { workspace: { columns: { teamId: true, dataClass: true } } },
    });
    if (!worker || worker.id !== id) return json({ error: 'Worker not found' }, 404);
    if (worker.accountId !== account.id || !worker.workspaceId || !worker.workspace?.teamId ||
      worker.workspace.teamId !== account.teamId || !tokenWorkspaceAllowed(account.workspaceIds, worker.workspaceId)) {
      return json({ error: 'Forbidden' }, 403);
    }
    if (worker.workspace.dataClass === 'sensitive') return json({ error: 'Sensitive workspace excluded' }, 403);
    if (!isTerminalWorkerStatus(worker.status)) return json({ error: 'Worker is not terminal' }, 409);
    // Reuse the authorized row, avoiding a second lookup with potentially changed identity.
    return json(await readCompletedSessionTranscript(id, { loadWorker: async () => worker }));
  } catch {
    return json({ error: 'Session transcript unavailable' }, 503);
  }
}
