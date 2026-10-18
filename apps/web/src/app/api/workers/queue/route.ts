/**
 * GET /api/workers/queue: per team, the order in which the calling runner's
 * claims take waiting work, and the waiting work it never takes with the
 * reason (spec c7410e76 R-26, AC-12). `buildd top`'s Queue view reads it
 * through the runner.
 *
 * Read-only. The reach is the claim route's own (lib/claim-order.ts
 * claimableWorkspaceIds), the order is its own (claimOrderBy) and so are the
 * gates (lib/claim-order-queue.ts); nothing here claims, stamps or records.
 *
 * Query (what the runner's claim body carries): `runner` (its runner id, for
 * the per-runner cooldown), `skills` (comma-separated advertised role slugs),
 * `executor` (host | cloud, default host).
 *
 * A runner key; per-task tokens and trigger keys are refused, as they cannot
 * make a broad claim either.
 *
 * Carries the workspaces' change version as an ETag (spec 3ef37387 R-20):
 * If-None-Match with the current one answers 304 without reading the queue.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isRunnerExecutor, type RunnerQueueResponse } from '@buildd/shared';
import { authenticateApiKey } from '@/lib/api-auth';
import { claimableWorkspaceIds } from '@/lib/claim-order';
import { loadRunnerQueue } from '@/lib/claim-order-queue';
import { listTag, notModifiedFor, queryKey, withTag, wsScope } from '@/lib/change-version';

/** The queue moves with the clock too (cooldowns, deferred starts): a tag holds a minute at most. */
const QUEUE_TAG_BUCKET_MS = 60_000;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey, req);
  if (!account) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  if ((account as any).level === 'trigger') {
    return NextResponse.json({ error: 'Trigger tokens cannot claim tasks, so they have no queue.' }, { status: 403 });
  }
  if ((account as any).taskScope) {
    return NextResponse.json({ error: 'A per-task token claims only its own task, so it has no queue.' }, { status: 403 });
  }

  const params = req.nextUrl.searchParams;
  const executor = params.get('executor') || 'host';
  if (!isRunnerExecutor(executor)) {
    return NextResponse.json({ error: "executor must be 'host' or 'cloud'" }, { status: 400 });
  }
  const runner = params.get('runner')?.trim() || null;
  const availableSkills = (params.get('skills') ?? '').split(',').map(s => s.trim()).filter(Boolean);

  try {
    // The broad claim's reach: no workspace narrowing from the query.
    const workspaceIds = await claimableWorkspaceIds(account as any, null);
    if (workspaceIds.length === 0) return NextResponse.json({ teams: [], truncated: false } satisfies RunnerQueueResponse);
    const tag = await listTag({
      route: '/api/workers/queue', caller: `acct:${(account as any).id}`,
      scopes: workspaceIds.map(wsScope), vary: [queryKey(params)], bucketMs: QUEUE_TAG_BUCKET_MS,
    });
    const unchanged = notModifiedFor(req, tag);
    if (unchanged) return unchanged;
    const out = await loadRunnerQueue({
      workspaceIds,
      caller: { accountType: String((account as any).type ?? ''), runner, availableSkills, executor },
      viewerUserId: (account as any).createdByUserId ?? null,
    });
    return withTag(NextResponse.json(out), tag);
  } catch (err) {
    console.error('[workers/queue] failed:', err);
    return NextResponse.json({ error: 'Failed to load the queue' }, { status: 500 });
  }
}
