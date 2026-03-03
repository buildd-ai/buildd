import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';

/**
 * GET /api/workspaces/[id]/integrations/slack
 * Returns workspace Slack config (minus botToken for security).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const access = await verifyWorkspaceAccess(user.id, id);
    if (!access) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, id),
      columns: { slackConfig: true },
    });

    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    // Strip botToken for security — only return whether it's set
    const config = workspace.slackConfig as {
      teamId?: string;
      channelId?: string;
      botToken?: string;
      enabled?: boolean;
    } | null;

    const safeConfig = config
      ? {
          teamId: config.teamId || '',
          channelId: config.channelId || '',
          hasBotToken: !!config.botToken,
          enabled: config.enabled ?? false,
        }
      : {
          teamId: '',
          channelId: '',
          hasBotToken: false,
          enabled: false,
        };

    return NextResponse.json({ slackConfig: safeConfig });
  } catch (error) {
    console.error('Get Slack config error:', error);
    return NextResponse.json({ error: 'Failed to get Slack config' }, { status: 500 });
  }
}

/**
 * PATCH /api/workspaces/[id]/integrations/slack
 * Updates Slack config fields.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const access = await verifyWorkspaceAccess(user.id, id);
    if (!access) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const body = await req.json();
    const { teamId, channelId, botToken, enabled } = body;

    // Fetch existing config to merge
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, id),
      columns: { slackConfig: true },
    });

    const existingConfig = (workspace?.slackConfig as {
      teamId?: string;
      channelId?: string;
      botToken?: string;
      enabled?: boolean;
    }) || {};

    const updatedConfig = {
      teamId: teamId !== undefined ? teamId : existingConfig.teamId,
      channelId: channelId !== undefined ? channelId : existingConfig.channelId,
      botToken: botToken !== undefined ? botToken : existingConfig.botToken,
      enabled: enabled !== undefined ? enabled : existingConfig.enabled,
    };

    await db
      .update(workspaces)
      .set({
        slackConfig: updatedConfig,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, id));

    // Return safe version (no botToken)
    return NextResponse.json({
      success: true,
      slackConfig: {
        teamId: updatedConfig.teamId || '',
        channelId: updatedConfig.channelId || '',
        hasBotToken: !!updatedConfig.botToken,
        enabled: updatedConfig.enabled ?? false,
      },
    });
  } catch (error) {
    console.error('Update Slack config error:', error);
    return NextResponse.json({ error: 'Failed to update Slack config' }, { status: 500 });
  }
}
