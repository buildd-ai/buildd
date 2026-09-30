import { db } from '@buildd/core/db';
import { githubInstallations, githubRepos, type WorkspaceWebhookConfig } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { dispatchToGitHubActions, isGitHubAppConfigured } from '@/lib/github';
import { isTaskNotHeldOrLocal } from '@/app/api/workers/claim/held-gate';

/**
 * Why the webhook fired. A consumer that runs tasks (the Cloudflare
 * dispatcher, docs/design/cloudflare-sandbox-runner.md) keys on `taskId`; the
 * event only says which path made the task claimable.
 */
export type TaskDispatchEvent = 'task.created' | 'task.unblocked' | 'task.retry' | 'task.resume';

/** How long a webhook POST may take before it counts as not dispatched. */
export const WEBHOOK_DISPATCH_TIMEOUT_MS = 10_000;

/**
 * Whether this webhook receives `event`.
 *
 * `webhookConfig.events` is an opt-in. A config that lists events gets exactly
 * those. A config without it (every webhook configured before the list
 * existed) keeps what it always received: `legacyDefault` is true only for the
 * two paths that reached webhooks before, new tasks (dispatchNewTask) and
 * dispatchUnblockedTask. Retries, approved-plan children and the deferred-start
 * sweep reach a webhook only when it lists the event.
 */
function webhookSubscribes(
  webhookConfig: WorkspaceWebhookConfig,
  event: TaskDispatchEvent,
  legacyDefault: boolean,
): boolean {
  return Array.isArray(webhookConfig.events) ? webhookConfig.events.includes(event) : legacyDefault;
}

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
  /** `task.resume` only: the parked worker the consumer continues. */
  workerId?: string;
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
  runnerPreference?: string | null;
}

export type DispatchWorkspace = {
  id?: string;
  name?: string;
  repo?: string | null;
  webhookConfig?: WorkspaceWebhookConfig | null;
  githubInstallationId?: string | null;
  githubRepoId?: string | null;
};

export function buildWebhookPayload(task: DispatchTask, event: TaskDispatchEvent, extra: { workerId?: string } = {}): TaskWebhookPayload {
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
    ...(extra.workerId ? { workerId: extra.workerId } : {}),
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
 * Dispatch task to external webhook (e.g., OpenClaw). False on any failure,
 * including no answer within `timeoutMs`, so the caller's Pusher fallback runs.
 */
export async function dispatchToWebhook(
  webhookConfig: WorkspaceWebhookConfig,
  task: DispatchTask,
  event: TaskDispatchEvent,
  timeoutMs: number = WEBHOOK_DISPATCH_TIMEOUT_MS,
  extra: { workerId?: string } = {},
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
      body: JSON.stringify(buildWebhookPayload(task, event, extra)),
      signal: AbortSignal.timeout(timeoutMs),
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
    if (
      webhookSubscribes(webhookConfig, 'task.created', true) &&
      webhookAcceptsRunnerPreference(webhookConfig, options?.runnerPreference)
    ) {
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

  // Check webhook dispatch. A webhook without `events` receives every call
  // here, whatever the event, with no runnerPreference filter: that is what
  // this path always did. One that lists events gets only those, filtered by
  // runnerPreference the way the new-task and retry paths are.
  let dispatched = false;
  if (workspace?.webhookConfig) {
    const webhookConfig = workspace.webhookConfig as WorkspaceWebhookConfig;
    const event = options?.event ?? 'task.unblocked';
    const optedIn = Array.isArray(webhookConfig.events);
    if (
      webhookSubscribes(webhookConfig, event, true) &&
      (!optedIn || webhookAcceptsRunnerPreference(webhookConfig, task.runnerPreference))
    ) {
      dispatched = await dispatchToWebhook(webhookConfig, task, event);
    }
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
 * The wake-up for paths that, before webhook `events` existed, sent only a
 * bare TASK_ASSIGNED broadcast (retries) or nothing at all (approved-plan
 * children, the deferred-start sweep). The webhook is tried only when the
 * config lists `event`, so an existing webhook consumer sees none of these;
 * everything else falls back to the broadcast, as before.
 *
 * When the webhook is tried:
 *  - It honours the task's runnerPreference, the filter dispatchNewTask
 *    applies, so a wake never reaches a webhook creation was kept away from.
 *  - A task deferred to a future `startAt` is not sent: the claim would
 *    refuse it until then, and a push consumer would spend a cold start
 *    learning that. The sweep re-sends it once `startAt` passes.
 *  - A held task, or one in a held or local-executor mission, is not sent
 *    (the claim route's notHeldOrLocal gate). A gate that cannot answer keeps
 *    the task off the webhook too.
 *  - No GitHub Actions dispatch: these paths never started an Actions run.
 */
async function wakeOptInWebhookOrBroadcast(
  task: DispatchTask & { startAt?: Date | string | null },
  workspace: DispatchWorkspace,
  event: TaskDispatchEvent,
): Promise<void> {
  const taskPayload = buildTaskPayload(task, workspace);

  let dispatched = false;
  const webhookConfig = workspace?.webhookConfig as WorkspaceWebhookConfig | null | undefined;
  const deferred = task.startAt != null && new Date(task.startAt).getTime() > Date.now();
  if (
    webhookConfig?.enabled &&
    webhookConfig.url &&
    !deferred &&
    webhookSubscribes(webhookConfig, event, false) &&
    webhookAcceptsRunnerPreference(webhookConfig, task.runnerPreference) &&
    (await isTaskNotHeldOrLocal(task.id).catch(() => false))
  ) {
    dispatched = await dispatchToWebhook(webhookConfig, task, event);
  }

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
 * `pending` (worker auto-retry / loop requeue, the reassign route) or whose
 * deferred `startAt` has passed (deferred-dispatch-sweep). Webhook only when
 * it lists 'task.retry'; see wakeOptInWebhookOrBroadcast.
 */
export async function dispatchRetriedTask(
  task: DispatchTask & { startAt?: Date | string | null },
  workspace: DispatchWorkspace,
): Promise<void> {
  await wakeOptInWebhookOrBroadcast(task, workspace, 'task.retry');
}

/**
 * Wake the cloud runner for a worker it parked (docs/design/cloudflare-sandbox-
 * runner.md, Phase 2 "Resumable runs"): the answer to its question is queued
 * on the SAME worker, and the consumer starts a container that re-attaches to
 * it (`POST /api/workers/[id]/reattach`). Webhook only, and only when it lists
 * 'task.resume'. No Pusher fallback: the worker is still live, so no polling
 * runner could claim the task, and an answer nobody picks up is degraded to a
 * cold continuation by cleanupUnresumedAnswers after RESUME_ACK_DEADLINE_MS.
 * No held-task gate either: the task was claimed long ago.
 */
export async function dispatchResumedTask(
  task: DispatchTask,
  workspace: DispatchWorkspace,
  workerId: string,
): Promise<boolean> {
  const webhookConfig = workspace?.webhookConfig as WorkspaceWebhookConfig | null | undefined;
  if (
    !webhookConfig?.enabled ||
    !webhookConfig.url ||
    !webhookSubscribes(webhookConfig, 'task.resume', false) ||
    !webhookAcceptsRunnerPreference(webhookConfig, task.runnerPreference)
  ) {
    return false;
  }
  return dispatchToWebhook(webhookConfig, task, 'task.resume', WEBHOOK_DISPATCH_TIMEOUT_MS, { workerId });
}

/**
 * Wake runners for a child an approved plan just created with nothing left to
 * wait on. Sent as 'task.created', to a webhook only when it lists that event
 * explicitly; see wakeOptInWebhookOrBroadcast.
 */
export async function dispatchPlanChildTask(
  task: DispatchTask,
  workspace: DispatchWorkspace,
): Promise<void> {
  await wakeOptInWebhookOrBroadcast(task, workspace, 'task.created');
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
