/**
 * POST /api/cron/connector-block-notify
 *
 * Runs every 5 minutes. For each pending task that was notified about a
 * connector block more than 30 minutes ago and has not yet received a reminder,
 * fires a reminder notification and stamps context.connectorBlockReminderSentAt.
 *
 * Auth: Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { notifyConnectorBlockReminder } from '../../workers/claim/connector-block-notify';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (token !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Find pending tasks that have a connector block notification but no reminder yet.
  const blockedTasks = await db.query.tasks.findMany({
    where: and(
      eq(tasks.status, 'pending'),
      sql`${tasks.context}->>'connectorBlockNotifiedAt' IS NOT NULL`,
      sql`${tasks.context}->>'connectorBlockReminderSentAt' IS NULL`,
    ),
    columns: {
      id: true,
      title: true,
      workspaceId: true,
      roleSlug: true,
      context: true,
    },
    with: { workspace: { columns: { id: true, name: true, teamId: true } } },
  });

  if (blockedTasks.length === 0) {
    return NextResponse.json({ ok: true, reminded: 0, checked: 0 });
  }

  let reminded = 0;
  const now = new Date();

  for (const task of blockedTasks) {
    const ctx = (task.context as Record<string, unknown> | null) ?? {};
    const notifiedAtStr = ctx.connectorBlockNotifiedAt as string | undefined;
    if (!notifiedAtStr) continue;
    const notifiedAt = new Date(notifiedAtStr);
    if (isNaN(notifiedAt.getTime())) continue;

    const teamId = (task as any).workspace?.teamId as string | undefined;
    if (!teamId) continue;

    // Reconstruct failures from context so the reminder message is meaningful.
    // If the stored failures list is missing we omit connector detail but still remind.
    const storedFailures = (ctx.connectorBlockFailures as Array<{
      connectorId: string;
      connectorName: string;
      mode: string;
    }> | undefined) ?? [];

    const sent = await notifyConnectorBlockReminder(
      {
        teamId,
        taskTitle: task.title,
        workspaceName: ((task as any).workspace?.name as string | undefined) ?? task.workspaceId,
        roleSlug: task.roleSlug ?? '',
        failures: storedFailures,
      },
      notifiedAt,
      false,
    );

    if (sent) {
      await db
        .update(tasks)
        .set({
          context: { ...ctx, connectorBlockReminderSentAt: now.toISOString() },
          updatedAt: now,
        })
        .where(eq(tasks.id, task.id));
      reminded++;
    }
  }

  return NextResponse.json({ ok: true, checked: blockedTasks.length, reminded });
}
