import { db } from '@buildd/core/db';
import { githubInstallations, githubRepos, type WorkspaceWebhookConfig } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { dispatchToGitHubActions, isGitHubAppConfigured } from '@/lib/github';

/**
 * Why the webhook fired. A consumer that runs tasks (the Cloudflare
 * dispatcher, docs/design/cloudflare-sandbox-runner.md) keys on `taskId`; the
 * event only says which path made the task claimable.
 */
export type TaskDispatchEvent = 'task.created' | 'task.unblocked' | 'task.retry';

/**
 * Body POSTed to `workspace.webhookConfig.url`.
 *
 * `message` / `sessionKey` / `name` are the original chat-shaped fields and
 * stay exactly as they were, so an existing chat-agent consumer is unaffected.
 * Everything after them is additive and structured, so a task-running consumer
 * never has to parse the task ID out of `message`.
 */
export interface TaskWebhookPayload {
  message: string;
  sessionKey: string;
  name: 'buildd';
  event: TaskDispatchEvent;
  taskId: string;
  workspaceId: string;
  missionId: string | null;
  backend: string | null;
  roleSlug: string | null;
}

/** The task fields the dispatch chain reads. Full task rows satisfy it. */
export interface DispatchTask {
  id: string;
  title: string;
  description: string | null;
  workspaceId: string;
  mode?: string;
  priority?: number;
  missionId?: string | null;
  backend?: string | null;
  roleSlug?: string | null;
}

export type DispatchWorkspace = {
  id?: string;
  name?: string;
  repo?: string | null;
  webhookConfig?: WorkspaceWebhookConfig | null;
  githubInstallationId?: string | null;
  githubRepoId?: string | null;
};

export function buildWebhookPayload(task: DispatchTask, event: TaskDispatchEvent): TaskWebhookPayload {
  const message = `Work on Buildd task: ${task.title}

${task.description || 'No description provided.'}

---
Task ID: ${task.id}
Report progress: POST ${process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev'}/api/workers/{workerId}`;

  return {
    message,
    sessionKey: `buildd-${task.id}`,
    name: 'buildd',
    event,
    taskId: task.id,
    workspaceId: task.workspaceId,
    missionId: task.missionId ?? null,
    backend: task.backend ?? null,
    roleSlug: task.roleSlug ?? null,
  };
}

/**
 * Whether a webhook restricted to one runner type takes a task with this
 * runner preference. An unrestricted webhook ('any' or unset) takes everything.
 */
function webhookAcceptsRunnerPreference(
  webhookConfig: WorkspaceWebhookConfig,
  runnerPreference: string | null | undefined,
): boolean {
  return !webhookConfig.runnerPreference ||
    webhookConfig.runnerPreference === 'any' ||
    webhookConfig.runnerPreference === (runnerPreference || 'any');
}

/**
 * Dispatch task to external webhook (e.g., OpenClaw)
 */
async function dispatchToWebhook(
  webhookConfig: WorkspaceWebhookConfig,
  task: DispatchTask,
  event: TaskDispatchEvent,
): Promise<boolean> {
  if (!webhookConfig.enabled || !webhookConfig.url) {
    return false;
  }

  try {
    const response = await fetch(webhookConfig.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${webhookConfig.token}`,
      },
      body: JSON.stringify(buildWebhookPayload(task, event)),
    });

    if (!response.ok) {
      console.error(`Webhook dispatch failed: ${response.status} ${await response.text()}`);
      return false;
    }

    console.log(`Task ${task.id} dispatched to webhook (${event}): ${webhookConfig.url}`);
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
 * 2. Direct runner assignment (if specified)
 * 3. Webhook dispatch (OpenClaw, etc.)
 * 4. GitHub Actions repository_dispatch (if workspace has GitHub integration)
 * 5. Fallback: Pusher TASK_ASSIGNED (connected local workers)
 */
export async function dispatchNewTask(
  task: DispatchTask,
  workspace: DispatchWorkspace,
  options?: {
    assignToLocalUiUrl?: string;
    runnerPreference?: string;
  }
): Promise<void> {
  const taskPayload = buildTaskPayload(task, workspace);

  // Trigger realtime event
  await triggerEvent(
    channels.workspace(task.workspaceId),
    events.TASK_CREATED,
    { task: taskPayload }
  );

  // If assigning to a specific runner, trigger assignment event
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
    if (webhookAcceptsRunnerPreference(webhookConfig, options?.runnerPreference)) {
      dispatched = await dispatchToWebhook(webhookConfig, task, 'task.created');
    }
  }

  // Try GitHub Actions dispatch if workspace has a linked GitHub repo
  // (supplementary — does NOT prevent Pusher broadcast to local runners)
  if (!dispatched) {
    tryGitHubActionsDispatch(workspace, task).catch(() => {});
  }

  // Always broadcast TASK_ASSIGNED so any connected local worker can claim.
  // Webhook dispatch is the only exclusive handler — GitHub Actions and
  // local runners can both pick up the same task (claim is atomic).
  if (!dispatched) {
    await triggerEvent(
      channels.workspace(task.workspaceId),
      events.TASK_ASSIGNED,
      { task: taskPayload, targetLocalUiUrl: null }
    );
  }
}

/**
 * Wake runners for a task whose dependsOn list just became fully resolved.
 * Runs the same dispatch chain as dispatchNewTask but skips TASK_CREATED —
 * the task already exists in the dashboard and re-emitting that event is noisy.
 *
 * `event` defaults to 'task.unblocked'; callers reusing this chain for another
 * reason (a manual reset to pending, a freshly approved plan's children) say so.
 */
export async function dispatchUnblockedTask(
  task: DispatchTask,
  workspace: DispatchWorkspace,
  options?: { event?: TaskDispatchEvent },
): Promise<void> {
  const taskPayload = buildTaskPayload(task, workspace);

  // Check webhook dispatch
  let dispatched = false;
  if (workspace?.webhookConfig) {
    const webhookConfig = workspace.webhookConfig as WorkspaceWebhookConfig;
    dispatched = await dispatchToWebhook(webhookConfig, task, options?.event ?? 'task.unblocked');
  }

  // Try GitHub Actions dispatch
  if (!dispatched) {
    tryGitHubActionsDispatch(workspace, task).catch(() => {});
  }

  // Broadcast TASK_ASSIGNED so any connected local worker can claim.
  if (!dispatched) {
    await triggerEvent(
      channels.workspace(task.workspaceId),
      events.TASK_ASSIGNED,
      { task: taskPayload, targetLocalUiUrl: null }
    );
  }
}

/**
 * Wake runners for a task an automatic or manual retry just put back to
 * `pending` (worker auto-retry / loop requeue, the reassign route).
 *
 * Narrower than dispatchUnblockedTask on purpose — it replaces what these
 * paths already did (a bare TASK_ASSIGNED broadcast) and adds only the webhook:
 *  - The webhook honours the task's own runnerPreference, the same filter
 *    dispatchNewTask applied when the task was created, so a retry never
 *    reaches a webhook the original dispatch was kept away from.
 *  - A task deferred to a future `startAt` (infra backoff) is not sent to the
 *    webhook: the claim would refuse it until then, and a push consumer would
 *    spend a cold start learning that. It falls back to the broadcast, exactly
 *    as before.
 *  - No GitHub Actions dispatch: these paths never started an Actions run.
 */
export async function dispatchRetriedTask(
  task: DispatchTask & { runnerPreference?: string | null; startAt?: Date | string | null },
  workspace: DispatchWorkspace,
): Promise<void> {
  const taskPayload = buildTaskPayload(task, workspace);

  let dispatched = false;
  const deferred = task.startAt != null && new Date(task.startAt).getTime() > Date.now();
  if (workspace?.webhookConfig && !deferred) {
    const webhookConfig = workspace.webhookConfig as WorkspaceWebhookConfig;
    if (webhookAcceptsRunnerPreference(webhookConfig, task.runnerPreference)) {
      dispatched = await dispatchToWebhook(webhookConfig, task, 'task.retry');
    }
  }

  if (!dispatched) {
    await triggerEvent(
      channels.workspace(task.workspaceId),
      events.TASK_ASSIGNED,
      { task: taskPayload, targetLocalUiUrl: null }
    );
  }
}

/** Build minimal task payload for Pusher events (10KB limit).
 * Never includes description — it can be multi-KB for heartbeat tasks and
 * neither dashboard consumers (they call router.refresh()) nor runners (they
 * fetch the full task from the claim API) need it in the Pusher event. */
export function buildTaskPayload(
  task: { id: string; title: string; workspaceId: string; mode?: string; priority?: number; missionId?: string | null; backend?: string | null },
  workspace: { name?: string; repo?: string | null },
) {
  return {
    id: task.id,
    title: task.title,
    workspaceId: task.workspaceId,
    mode: task.mode,
    priority: task.priority,
    // Which agent backend this task runs on. The runner keys its per-context
    // claim breaker on `<scope>:<backend>`, so without this field every nudge
    // is evaluated against the Claude key and a nudge for a walled backend is
    // either wrongly dropped or wrongly attempted. One short string — well
    // inside the 10KB Pusher payload budget.
    ...(task.backend && { backend: task.backend }),
    // Include missionId so dashboard can filter events per mission
    ...(task.missionId && { missionId: task.missionId }),
    // Include workspace info so runners can resolve workspace path before claiming
    ...(workspace.name && { workspace: { name: workspace.name, repo: workspace.repo || null } }),
  };
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
