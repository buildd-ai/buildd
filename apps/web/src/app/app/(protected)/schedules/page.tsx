import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { asc, inArray } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';
import { isSystemWorkspace } from '@buildd/shared';
import { schedulesRedirectTarget } from './schedules-redirect';

export const dynamic = 'force-dynamic';

/**
 * Retired as a page of its own: a schedule lives where it is configured, on
 * its mission or in the workspace's schedules. Links to /app/schedules keep
 * working and land there.
 */
export default async function SchedulesPage({ searchParams }: { searchParams: Promise<{ workspace?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');
  const { workspace } = await searchParams;
  const wsIds = await getUserWorkspaceIds(user.id);
  const rows = wsIds.length === 0 ? [] : await db.query.workspaces.findMany({
    where: inArray(workspaces.id, wsIds),
    columns: { id: true, name: true },
    orderBy: [asc(workspaces.name)],
  });
  redirect(schedulesRedirectTarget({ requested: workspace ?? null, workspaces: rows.filter(w => !isSystemWorkspace(w.name)) }));
}
