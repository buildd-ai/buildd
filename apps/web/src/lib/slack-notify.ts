/**
 * Send a notification to a Slack channel via the workspace's Slack bot.
 *
 * @param workspace - Must include slackConfig with botToken, channelId, and enabled flag
 * @param message   - The text message to post
 * @param threadTs  - Optional thread timestamp to reply in a thread
 */
export async function notifySlack(
  workspace: {
    slackConfig?: {
      botToken?: string;
      channelId?: string;
      enabled?: boolean;
    } | null;
  },
  message: string,
  threadTs?: string
): Promise<void> {
  const config = workspace.slackConfig;
  if (!config?.enabled || !config.botToken || !config.channelId) return;

  try {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: config.channelId,
        text: message,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }),
    });

    if (!response.ok) {
      console.error(`Slack notification failed: ${response.status}`);
    } else {
      const data = await response.json();
      if (!data.ok) {
        console.error(`Slack API error: ${data.error}`);
      }
    }
  } catch (error) {
    console.error('Slack notification error:', error);
  }
}
