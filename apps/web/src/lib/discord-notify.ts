/**
 * Send a notification message to a workspace's configured Discord channel.
 *
 * No-ops silently if Discord is not configured or not enabled.
 */
export async function notifyDiscord(
  workspace: { discordConfig?: { botToken?: string; channelId?: string; enabled?: boolean } | null },
  content: string,
  embed?: { title: string; description: string; color?: number; url?: string }
): Promise<void> {
  const config = workspace.discordConfig;
  if (!config?.enabled || !config.botToken || !config.channelId) return;

  try {
    await fetch(`https://discord.com/api/v10/channels/${config.channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${config.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content,
        ...(embed ? { embeds: [embed] } : {}),
      }),
    });
  } catch (error) {
    // Log but don't throw — Discord notifications are best-effort
    console.error('Discord notification failed:', error);
  }
}
