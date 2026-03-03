import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { dispatchNewTask } from '@/lib/task-dispatch';

// Discord interaction types
const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
} as const;

const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
} as const;

// ── Signature verification ─────────────────────────────────────────────────

function hexToUint8Array(hex: string): Uint8Array {
  const matches = hex.match(/.{1,2}/g) || [];
  return new Uint8Array(matches.map(byte => parseInt(byte, 16)));
}

async function verifyDiscordSignature(req: NextRequest, body: string): Promise<boolean> {
  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKey) return false;

  const signature = req.headers.get('x-signature-ed25519');
  const timestamp = req.headers.get('x-signature-timestamp');
  if (!signature || !timestamp) return false;

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToUint8Array(publicKey) as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify']
    );

    const isValid = await crypto.subtle.verify(
      'Ed25519',
      key,
      hexToUint8Array(signature) as BufferSource,
      new TextEncoder().encode(timestamp + body)
    );
    return isValid;
  } catch (error) {
    console.error('Discord signature verification failed:', error);
    return false;
  }
}

// ── POST handler ───────────────────────────────────────────────────────────

/**
 * POST /api/integrations/discord
 *
 * Handles Discord Interactions API:
 * 1. PING (type 1) - respond with PONG for Discord verification
 * 2. APPLICATION_COMMAND (type 2) - /buildd <goal> slash command
 * 3. MESSAGE_COMPONENT (type 3) - button interactions (approve plan, etc.)
 */
export async function POST(req: NextRequest) {
  const body = await req.text();

  // Verify Discord signature
  const isValid = await verifyDiscordSignature(req, body);
  if (!isValid) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let interaction: any;
  try {
    interaction = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // 1. Handle PING (Discord verification handshake)
  if (interaction.type === InteractionType.PING) {
    return NextResponse.json({ type: InteractionResponseType.PONG });
  }

  // 2. Handle APPLICATION_COMMAND (slash commands)
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    return handleSlashCommand(interaction);
  }

  // 3. Handle MESSAGE_COMPONENT (button clicks, etc.)
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    return handleComponentInteraction(interaction);
  }

  // Unknown interaction type
  return NextResponse.json({ error: 'Unknown interaction type' }, { status: 400 });
}

// ── Slash command handler ──────────────────────────────────────────────────

async function handleSlashCommand(interaction: any) {
  const commandName = interaction.data?.name;

  if (commandName !== 'buildd') {
    return NextResponse.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'Unknown command.', flags: 64 }, // ephemeral
    });
  }

  // Extract the goal from the command options
  const goalOption = interaction.data.options?.find((opt: any) => opt.name === 'goal');
  const goal = goalOption?.value as string | undefined;

  if (!goal) {
    return NextResponse.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'Please provide a goal. Usage: `/buildd <goal>`', flags: 64 },
    });
  }

  const guildId = interaction.guild_id as string | undefined;
  if (!guildId) {
    return NextResponse.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'This command can only be used in a server.', flags: 64 },
    });
  }

  try {
    // Look up workspace by Discord guild ID
    const allWorkspaces = await db.query.workspaces.findMany();
    const workspace = allWorkspaces.find(
      (ws) => (ws.discordConfig as any)?.guildId === guildId
    );

    if (!workspace) {
      return NextResponse.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: 'No buildd workspace is linked to this Discord server. Configure Discord integration in your workspace settings.',
          flags: 64,
        },
      });
    }

    // Create a planning-mode task
    const [task] = await db
      .insert(tasks)
      .values({
        workspaceId: workspace.id,
        title: goal,
        description: `Created from Discord by <@${interaction.member?.user?.id || 'unknown'}> in <#${interaction.channel_id || 'unknown'}>`,
        status: 'pending',
        mode: 'planning',
        priority: 0,
        runnerPreference: 'any',
        requiredCapabilities: [],
        context: {
          discord: {
            guildId,
            channelId: interaction.channel_id,
            userId: interaction.member?.user?.id,
            username: interaction.member?.user?.username,
            interactionId: interaction.id,
          },
        },
        creationSource: 'api',
        createdByAccountId: null,
        createdByWorkerId: null,
        parentTaskId: null,
      })
      .returning();

    // Dispatch the task
    await dispatchNewTask(task, workspace);

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev';
    const taskUrl = `${appUrl}/app/tasks/${task.id}`;

    return NextResponse.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [
          {
            title: `Task Created: ${goal}`,
            description: `A planning-mode task has been created and is ready for a worker to pick up.`,
            color: 0x6366f1, // indigo
            fields: [
              { name: 'Status', value: 'Pending', inline: true },
              { name: 'Mode', value: 'Planning', inline: true },
            ],
            url: taskUrl,
            footer: { text: `Task ID: ${task.id}` },
            timestamp: new Date().toISOString(),
          },
        ],
      },
    });
  } catch (error) {
    console.error('Discord slash command error:', error);
    return NextResponse.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'Failed to create task. Please try again later.', flags: 64 },
    });
  }
}

// ── Component interaction handler ──────────────────────────────────────────

async function handleComponentInteraction(interaction: any) {
  const customId = interaction.data?.custom_id as string | undefined;

  if (!customId) {
    return NextResponse.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'Invalid interaction.', flags: 64 },
    });
  }

  // Handle approve plan button: custom_id format "approve_plan:<taskId>"
  if (customId.startsWith('approve_plan:')) {
    const taskId = customId.split(':')[1];
    if (!taskId) {
      return NextResponse.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: 'Invalid task reference.', flags: 64 },
      });
    }

    try {
      const [updatedTask] = await db
        .update(tasks)
        .set({ mode: 'execution', updatedAt: new Date() })
        .where(eq(tasks.id, taskId))
        .returning();

      if (!updatedTask) {
        return NextResponse.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: 'Task not found.', flags: 64 },
        });
      }

      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev';

      return NextResponse.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          embeds: [
            {
              title: `Plan Approved: ${updatedTask.title}`,
              description: 'Task has been switched to execution mode.',
              color: 0x22c55e, // green
              url: `${appUrl}/app/tasks/${updatedTask.id}`,
              footer: { text: `Approved by ${interaction.member?.user?.username || 'unknown'}` },
              timestamp: new Date().toISOString(),
            },
          ],
        },
      });
    } catch (error) {
      console.error('Discord approve plan error:', error);
      return NextResponse.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: 'Failed to approve plan. Please try again.', flags: 64 },
      });
    }
  }

  // Unknown component interaction
  return NextResponse.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: 'Unknown action.', flags: 64 },
  });
}
