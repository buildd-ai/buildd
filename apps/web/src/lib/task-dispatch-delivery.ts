import { db } from '@buildd/core/db';
import { githubInstallations, githubRepos, type WorkspaceWebhookConfig } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { dispatchToGitHubActions, isGitHubAppConfigured } from '@/lib/github';

/**
 * Delivery primitives for task wakes: the webhook POST, GitHub Actions
 * repository_dispatch and the Pusher payload shape. Only the dispatch
 * authority (lib/dispatch-authority.ts) sends task wakes with these; the one
 * other sender is `dispatchResumedTask`, which resumes a live *worker* and so
 * is not a task wake at all.
 *
 * Why the webhook fired. A consumer that runs tasks (the Cloudflare
 * dispatcher, docs/design/cloudflare-sandbox-runner.md) keys on `taskId`; the
 * event only says which path made the task claimable.
 */
export type TaskDispatchEvent = 'task.created' | 'task.unblocked' | 'task.retry' | 'task.resume' | 'task.scheduled';

/**
 * How far ahead a `task.scheduled` notice may point. A wake due further out
 * gets its notice on a later timer publish, once it is within range. Mirrors the
 * cloud runner's bound (apps/cloud-runner/src/http.ts SCHEDULE_MAX_AHEAD_MS),
 * which refuses anything later.
 */
export const SCHEDULED_DISPATCH_MAX_AHEAD_MS = 24 * 60 * 60 * 1000;

/** How long a webhook POST may take before it counts as not dispatched. */
export const WEBHOOK_DISPATCH_TIMEOUT_MS = 10_000;

/**
 * Whether this webhook receives `event`. `webhookConfig.events` is an opt-in;
 * a config without it gets only `legacyDefault` events. Task wakes decide this
 * per cause in lib/dispatch-authority.ts (`webhookWants`); this copy serves the
 * worker-level `task.resume` below.
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
  /**
   * Why the dispatch authority woke the task (DispatchCause), and the outbox
   * row that carried it. Additive; a consumer may log or dedupe on `dispatchId`
   * but must not treat either as permission — the claim decides.
   */
  cause?: string;
  dispatchId?: string;
  /**
   * `task.scheduled` only: ISO time the task becomes claimable (its
   * `startAt`). The consumer starts the run then, not now.
   */
  notBefore?: string;
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
  /** Deferred start: the claim refuses the task until then. */
  startAt?: Date | string | null;
}

export type DispatchWorkspace = {
  id?: string;
  name?: string;
  repo?: string | null;
  webhookConfig?: WorkspaceWebhookConfig | null;
  githubInstallationId?: string | null;
  githubRepoId?: string | null;
};

export type WebhookPayloadExtra = { workerId?: string; cause?: string; dispatchId?: string; notBefore?: string };

export function buildWebhookPayload(task: DispatchTask, event: TaskDispatchEvent, extra: WebhookPayloadExtra = {}): TaskWebhookPayload {
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
    ...(extra.cause ? { cause: extra.cause } : {}),
    ...(extra.dispatchId ? { dispatchId: extra.dispatchId } : {}),
    ...(extra.notBefore ? { notBefore: extra.notBefore } : {}),
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
  extra: WebhookPayloadExtra = {},
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
export async function tryGitHubActionsDispatch(
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
