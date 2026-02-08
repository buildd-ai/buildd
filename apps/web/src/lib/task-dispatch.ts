import { type WorkspaceWebhookConfig } from '@buildd/core/db/schema';
import { triggerEvent, channels, events } from '@/lib/pusher';

/**
 * Dispatch task to external webhook (e.g., OpenClaw)
 */
async function dispatchToWebhook(
  webhookConfig: WorkspaceWebhookConfig,
  task: { id: string; title: string; description: string | null; workspaceId: string }
): Promise<boolean> {
  if (!webhookConfig.enabled || !webhookConfig.url) {
    return false;
  }

  try {
    const message = `Work on Buildd task: ${task.title}

${task.description || 'No description provided.'}

---
Task ID: ${task.id}
Report progress: POST ${process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev'}/api/workers/{workerId}`;

    const response = await fetch(webhookConfig.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${webhookConfig.token}`,
      },
      body: JSON.stringify({
        message,
        sessionKey: `buildd-${task.id}`,
        name: 'buildd',
      }),
    });

    if (!response.ok) {
      console.error(`Webhook dispatch failed: ${response.status} ${await response.text()}`);
      return false;
    }

    console.log(`Task ${task.id} dispatched to webhook: ${webhookConfig.url}`);
    return true;
  } catch (error) {
    console.error('Webhook dispatch error:', error);
    return false;
  }
}

/**
 * Dispatch a newly created task via Pusher events and webhook.
 *
 * Handles: TASK_CREATED event, webhook check, TASK_ASSIGNED fallback.
 */
export async function dispatchNewTask(
  task: { id: string; title: string; description: string | null; workspaceId: string },
  workspace: { webhookConfig?: WorkspaceWebhookConfig | null },
  options?: {
    assignToLocalUiUrl?: string;
    runnerPreference?: string;
  }
): Promise<void> {
  // Trigger realtime event
  await triggerEvent(
    channels.workspace(task.workspaceId),
    events.TASK_CREATED,
    { task }
  );

  // If assigning to a specific local-ui, trigger assignment event
  if (options?.assignToLocalUiUrl) {
    await triggerEvent(
      channels.workspace(task.workspaceId),
      events.TASK_ASSIGNED,
      { task, targetLocalUiUrl: options.assignToLocalUiUrl }
    );
    return;
  }

  // Check webhook dispatch
  let dispatched = false;
  if (workspace?.webhookConfig) {
    const webhookConfig = workspace.webhookConfig as WorkspaceWebhookConfig;
    const shouldDispatch = !webhookConfig.runnerPreference ||
      webhookConfig.runnerPreference === 'any' ||
      webhookConfig.runnerPreference === (options?.runnerPreference || 'any');

    if (shouldDispatch) {
      dispatched = await dispatchToWebhook(webhookConfig, task);
    }
  }

  // If no webhook handled it, broadcast TASK_ASSIGNED so any connected worker can claim
  if (!dispatched) {
    await triggerEvent(
      channels.workspace(task.workspaceId),
      events.TASK_ASSIGNED,
      { task, targetLocalUiUrl: null }
    );
  }
}
