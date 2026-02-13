import { db } from '@buildd/core/db';
import { githubInstallations, githubRepos, type WorkspaceWebhookConfig } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { dispatchToGitHubActions, isGitHubAppConfigured } from '@/lib/github';

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
 * Dispatch a newly created task via Pusher events, webhook, and GitHub Actions.
 *
 * Dispatch chain:
 * 1. Pusher TASK_CREATED (real-time dashboard)
 * 2. Direct local-ui assignment (if specified)
 * 3. Webhook dispatch (OpenClaw, etc.)
 * 4. GitHub Actions repository_dispatch (if workspace has GitHub integration)
 * 5. Fallback: Pusher TASK_ASSIGNED (connected local workers)
 */
export async function dispatchNewTask(
  task: { id: string; title: string; description: string | null; workspaceId: string; mode?: string; priority?: number },
  workspace: {
    id?: string;
    webhookConfig?: WorkspaceWebhookConfig | null;
    githubInstallationId?: string | null;
    githubRepoId?: string | null;
  },
  options?: {
    assignToLocalUiUrl?: string;
    runnerPreference?: string;
  }
): Promise<void> {
  // Build minimal task payload for Pusher events (10KB limit).
  // Local-ui fetches the full task (with context/attachments) via the claim API.
  const taskPayload = {
    id: task.id,
    title: task.title,
    description: task.description,
    workspaceId: task.workspaceId,
    mode: task.mode,
    priority: task.priority,
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

  // Try GitHub Actions dispatch if workspace has a linked GitHub repo
  if (!dispatched) {
    dispatched = await tryGitHubActionsDispatch(workspace, task);
  }

  // If nothing handled it, broadcast TASK_ASSIGNED so any connected worker can claim
  if (!dispatched) {
    await triggerEvent(
      channels.workspace(task.workspaceId),
      events.TASK_ASSIGNED,
      { task: taskPayload, targetLocalUiUrl: null }
    );
  }
}

/**
 * Try to dispatch a task via GitHub Actions repository_dispatch.
 * Requires workspace to have a linked GitHub installation and repo.
 */
async function tryGitHubActionsDispatch(
  workspace: {
    id?: string;
    githubInstallationId?: string | null;
    githubRepoId?: string | null;
  },
  task: { id: string; title: string; description: string | null; workspaceId: string; mode?: string; priority?: number }
): Promise<boolean> {
  if (!isGitHubAppConfigured() || !workspace.githubInstallationId || !workspace.githubRepoId) {
    return false;
  }

  try {
    // Look up the GitHub installation's numeric ID and repo full name
    const installation = await db.query.githubInstallations.findFirst({
      where: eq(githubInstallations.id, workspace.githubInstallationId),
    });

    const repo = await db.query.githubRepos.findFirst({
      where: eq(githubRepos.id, workspace.githubRepoId),
    });

    if (!installation || !repo) {
      return false;
    }

    return await dispatchToGitHubActions(
      installation.installationId,
      repo.fullName,
      task
    );
  } catch (error) {
    console.error('GitHub Actions dispatch lookup failed:', error);
    return false;
  }
}
