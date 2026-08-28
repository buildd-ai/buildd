/**
 * POST /api/cron/connector-block-notify
 *
 * Runs every 5 minutes and does two passes:
 *
 * 1. Reminders — for each pending task notified about a connector block more
 *    than 30 minutes ago with no reminder yet, fires a reminder and stamps
 *    context.connectorBlockReminderSentAt.
 * 2. Proactive expiry scan — for each connector credential that can no longer
 *    heal itself and has not been alerted, fires an alert and
 *    stamps secrets.expiryNotifiedAt. Pass 1 alone only ever fires *after* a
 *    task has already tripped over the dead connector, so a connector no
 *    current task requires would expire in silence.
 *
 * Auth: Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, secrets, connectors } from '@buildd/core/db/schema';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { notifyConnectorBlockReminder, notifyConnectorExpiry } from '../../workers/claim/connector-block-notify';
import { shouldNotifyExpiry } from '@/lib/connector-status';

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

  // ── Pass 2: proactive connector-credential expiry scan ──────────────────────
  const credentials = await db.query.secrets.findMany({
    where: eq(secrets.purpose, 'mcp_connector_credential'),
    columns: {
      id: true,
      teamId: true,
      label: true,
      tokenExpiresAt: true,
      lastVerificationError: true,
      expiryNotifiedAt: true,
    },
  });

  // `label` holds the connector id (see /api/connectors).
  const due = credentials.filter(c => c.label && shouldNotifyExpiry(c, now));

  let expiryAlerted = 0;
  if (due.length > 0) {
    const connectorRows = await db.query.connectors.findMany({
      where: inArray(connectors.id, due.map(c => c.label as string)),
      columns: { id: true, name: true },
    });
    const nameById = new Map(connectorRows.map(c => [c.id, c.name]));

    for (const cred of due) {
      // A credential whose connector was deleted is orphaned — nothing to reconnect.
      const connectorName = nameById.get(cred.label as string);
      if (!connectorName) continue;

      const sent = await notifyConnectorExpiry({
        teamId: cred.teamId,
        connectorName,
        tokenExpiresAt: cred.tokenExpiresAt,
        refreshError: cred.lastVerificationError,
      });

      if (sent) {
        await db
          .update(secrets)
          .set({ expiryNotifiedAt: now, updatedAt: now })
          .where(eq(secrets.id, cred.id));
        expiryAlerted++;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    checked: blockedTasks.length,
    reminded,
    credentialsChecked: credentials.length,
    expiryAlerted,
  });
}
