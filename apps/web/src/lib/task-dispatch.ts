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
Report progress: POST ${process.env.NEXT_PUBLIC_APP_URL || 'https://app.buildd.dev'}/api/workers/{workerId}`;

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
  task: { id: string; title: string; description: string | null; workspaceId: string; status?: string; mode?: string; priority?: number; workspace?: { name?: string; repo?: string | null } },
  workspace: { webhookConfig?: WorkspaceWebhookConfig | null },
  options?: {
    assignToLocalUiUrl?: string;
    runnerPreference?: string;
  }
): Promise<void> {
  // Build a minimal task payload for Pusher events (10KB limit).
  // Local-ui fetches the full task (with context/attachments) via the claim API.
  const taskPayload = {
    id: task.id,
    title: task.title,
    description: task.description,
    workspaceId: task.workspaceId,
    status: task.status,
    mode: task.mode,
    priority: task.priority,
    workspace: task.workspace ? {
      name: task.workspace.name,
      repo: task.workspace.repo,
    } : undefined,
  };

  // Trigger realtime event
  await triggerEvent(
    channels.workspace(task.workspaceId),
    events.TASK_CREATED,
    { task: taskPayload }
  );

  // If assigning to a specific local-ui, trigger assignment event
  if (options?.assignToLocalUiUrl) {
    await triggerEvent(
      channels.workspace(task.workspaceId),
      events.TASK_ASSIGNED,
      { task: taskPayload, targetLocalUiUrl: options.assignToLocalUiUrl }
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
      { task: taskPayload, targetLocalUiUrl: null }
    );
  }
}
