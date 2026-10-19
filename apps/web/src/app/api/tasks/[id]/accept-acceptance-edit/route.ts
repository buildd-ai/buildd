import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { acceptAcceptanceEdit } from '@/lib/acceptance-edit-store';
import { isUuid } from '@/lib/uuid';

// POST /api/tasks/[id]/accept-acceptance-edit - a person accepts a building task's change to an acceptance test.
// Session only: no API key or task token can accept (spec R-80).
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const task = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, id)), columns: { id: true, workspaceId: true } });
  if (!task || !(await verifyWorkspaceAccess(user.id, task.workspaceId))) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  const result = await acceptAcceptanceEdit(task.id, `user:${user.id}`);
  if (result === 'nothing_flagged') return NextResponse.json({ error: 'No acceptance-test edit is waiting for acceptance' }, { status: 409 });
  return NextResponse.json({ ok: true });
}
