import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { dispatchNewTask } from '@/lib/task-dispatch';
import crypto from 'crypto';

/**
 * Verify Slack request signature using HMAC-SHA256.
 * See: https://api.slack.com/authentication/verifying-requests-from-slack
 */
function verifySlackSignature(req: Request, body: string): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return false;

  const timestamp = req.headers.get('x-slack-request-timestamp');
  const signature = req.headers.get('x-slack-signature');
  if (!timestamp || !signature) return false;

  // Verify timestamp is within 5 minutes to prevent replay attacks
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const sigBasestring = `v0:${timestamp}:${body}`;
  const hmac = crypto
    .createHmac('sha256', signingSecret)
    .update(sigBasestring)
    .digest('hex');

  return signature === `v0=${hmac}`;
}

/**
 * POST /api/integrations/slack
 *
 * Handles Slack Events API + slash commands:
 * 1. url_verification challenge (Slack setup handshake)
 * 2. Slash command: /buildd <goal> - creates a planning-mode task
 * 3. Event callbacks: message events in threads - add as task context
 */
export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') || '';
  const rawBody = await req.text();

  // Verify Slack signature (skip for url_verification during initial setup)
  const isVerified = verifySlackSignature(req, rawBody);

  // ── Slash command (application/x-www-form-urlencoded) ──────────────────
  if (contentType.includes('application/x-www-form-urlencoded')) {
    if (!isVerified) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    const params = new URLSearchParams(rawBody);
    const commandText = params.get('text') || '';
    const teamId = params.get('team_id') || '';
    const userId = params.get('user_id') || '';
    const userName = params.get('user_name') || 'slack-user';

    if (!commandText.trim()) {
      return NextResponse.json({
        response_type: 'ephemeral',
        text: 'Usage: /buildd <task description>',
      });
    }

    try {
      // Look up workspace by Slack team ID
      const workspace = await findWorkspaceBySlackTeamId(teamId);
      if (!workspace) {
        return NextResponse.json({
          response_type: 'ephemeral',
          text: 'No workspace is linked to this Slack team. Configure Slack integration in your buildd workspace settings.',
        });
      }

      // Create a planning-mode task
      const [newTask] = await db
        .insert(tasks)
        .values({
          workspaceId: workspace.id,
          title: commandText.trim(),
          description: `Created via Slack by @${userName}`,
          status: 'pending',
          mode: 'planning',
          creationSource: 'api',
          context: {
            slack: {
              teamId,
              userId,
              userName,
            },
          },
        })
        .returning();

      if (newTask) {
        await dispatchNewTask(newTask, workspace);
      }

      return NextResponse.json({
        response_type: 'ephemeral',
        text: `Task created: "${commandText.trim()}" -- I'll notify you when the plan is ready.`,
      });
    } catch (error) {
      console.error('Slack slash command error:', error);
      return NextResponse.json({
        response_type: 'ephemeral',
        text: 'Failed to create task. Please try again later.',
      });
    }
  }

  // ── JSON payload (Events API) ──────────────────────────────────────────
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // 1. URL verification challenge (Slack setup handshake)
  if (data.type === 'url_verification') {
    return NextResponse.json({ challenge: data.challenge });
  }

  // All other events require signature verification
  if (!isVerified) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // 2. Event callbacks
  if (data.type === 'event_callback') {
    const event = data.event as Record<string, unknown> | undefined;
    if (!event) {
      return NextResponse.json({ ok: true });
    }

    // Handle message events in threads
    if (event.type === 'message' && event.thread_ts) {
      try {
        const threadTs = event.thread_ts as string;
        const messageText = event.text as string;
        const teamId = (data.team_id as string) || '';

        if (!messageText) {
          return NextResponse.json({ ok: true });
        }

        // Find workspace by team ID
        const workspace = await findWorkspaceBySlackTeamId(teamId);
        if (!workspace) {
          return NextResponse.json({ ok: true });
        }

        // Find task associated with this thread via context.slack.threadTs
        // Tasks created from Slack could store threadTs in context
        const workspaceTasks = await db.query.tasks.findMany({
          where: eq(tasks.workspaceId, workspace.id),
        });

        const matchingTask = workspaceTasks.find((t) => {
          const ctx = t.context as Record<string, unknown> | null;
          const slackCtx = ctx?.slack as Record<string, unknown> | undefined;
          return slackCtx?.threadTs === threadTs;
        });

        if (matchingTask) {
          // Append the message as context update
          const existingContext = (matchingTask.context as Record<string, unknown>) || {};
          const slackMessages = (existingContext.slackMessages as string[]) || [];
          slackMessages.push(messageText);

          await db
            .update(tasks)
            .set({
              context: { ...existingContext, slackMessages },
              updatedAt: new Date(),
            })
            .where(eq(tasks.id, matchingTask.id));
        }
      } catch (error) {
        console.error('Slack thread message handling error:', error);
      }
    }

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}

/**
 * Find a workspace by its Slack team ID via the slackConfig JSONB field.
 */
async function findWorkspaceBySlackTeamId(teamId: string) {
  if (!teamId) return null;

  // Query all workspaces and filter by slackConfig.teamId
  // (JSONB filtering — could be optimized with a generated column/index if needed)
  const allWorkspaces = await db.query.workspaces.findMany();
  return allWorkspaces.find((w) => {
    const config = w.slackConfig as { teamId?: string; enabled?: boolean } | null;
    return config?.teamId === teamId && config?.enabled !== false;
  }) || null;
}
