import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { loadHealthQueueFor } from '@/lib/health-queue-scope';
import { buildHealthQueueView } from '@/lib/health-queue-view';

/**
 * GET /api/health/queue: Health › Queue for the signed-in member's active
 * team (spec "Health › Queue"). The tab pages and filters through it; the
 * page's first render reads the same scope (lib/health-queue-scope.ts).
 *
 * Query: `workspace` (one of the team's), `mission`, `reason`
 * (all | declared | lane | limit), `page` (50 waiting rows each).
 *
 * Read-only. Slots and idle capacity are team-wide whatever the filters.
 * Response: HealthQueueResponse (@buildd/shared).
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const q = req.nextUrl.searchParams;
  try {
    const loaded = await loadHealthQueueFor(user.id, req.cookies.get('buildd-team')?.value ?? null, {
      workspace: q.get('workspace'),
      mission: q.get('mission'),
      reason: q.get('reason'),
      page: q.get('page'),
    });
    if (loaded.kind === 'no-team') return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    if (loaded.kind === 'no-workspaces') {
      return NextResponse.json(buildHealthQueueView({ now: Date.now(), running: 0, slots: 0, teamBusy: 0, tasks: [], lanes: [], filter: 'all', page: 1, truncated: false, missions: [] }));
    }
    return NextResponse.json(loaded.view);
  } catch (err) {
    console.error('[health/queue] read failed:', err);
    return NextResponse.json({ error: 'Could not load the queue. Try again.' }, { status: 500 });
  }
}
