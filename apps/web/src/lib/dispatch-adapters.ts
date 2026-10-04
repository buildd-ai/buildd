/**
 * Destination adapters for durable dispatch intent (lib/dispatch-authority.ts).
 *
 * The authority's loop offers each due intent to these in order. It carries a
 * stable context — the task id, the cause trail, delivery hints — and no
 * opinion about what the destination does: durable dispatch does not imply
 * autonomous execution. Which destination receives a wake, and in what
 * execution mode, is policy that lives here, above the substrate.
 *
 * Today every adapter wakes a runner that will call the claim route, which
 * stays the only scheduling authority. A future destination (an interactive
 * session, an external work system) is a new adapter in a chain, not a branch
 * in the dispatcher — and keeps its own business semantics to itself.
 */
import type { WorkspaceWebhookConfig } from '@buildd/core/db/schema';
import type { DispatchCause, DispatchIntent } from '@buildd/core/dispatch-outbox';
import { channels, events, triggerEventChecked } from '@/lib/pusher';
import {
  SCHEDULED_DISPATCH_MAX_AHEAD_MS,
  buildTaskPayload,
  dispatchToWebhook,
  tryGitHubActionsDispatch,
  type DispatchTask,
  type DispatchWorkspace,
  type TaskDispatchEvent,
} from '@/lib/task-dispatch-delivery';
import { isTaskNotHeldOrLocal } from '@/app/api/workers/claim/held-gate';

/** What an adapter is offered: the intent and the task it names. */
export interface DispatchContext {
  dispatchId: string;
  intent: DispatchIntent;
  /** 1 on the first delivery attempt of this intent; higher on a retry. */
  attemptCount: number;
  /** The most specific cause in the trail (primaryCause). */
  cause: DispatchCause;
  causes: readonly DispatchCause[];
  /** Delivery hints recorded with the intent, e.g. { targetLocalUiUrl }. */
  metadata: Record<string, unknown> | null;
  task: DispatchTask & { status: string; startAt: Date | null };
  workspace: DispatchWorkspace;
}

/**
 * `delivered` ends the chain and closes the intent; `skipped` closes it with
 * nothing sent (this destination class says the wake is moot); `declined`
 * passes it to the next adapter. Throw to have the intent retried.
 */
export type AdapterOutcome =
  | { kind: 'delivered'; via: string }
  | { kind: 'skipped'; why: string }
  | { kind: 'declined' };

export interface DispatchAdapter {
  name: string;
  offer(ctx: DispatchContext): Promise<AdapterOutcome>;
}

const DECLINED: AdapterOutcome = { kind: 'declined' };

// ── Runner wake policy (pure) ──────────────────────────────────────────────

export interface CauseRoute {
  event: TaskDispatchEvent;
  /**
   * Whether a webhook with no `events` list receives it. True exactly for the
   * causes the pre-outbox `dispatchNewTask` / `dispatchUnblockedTask` reached
   * a webhook for, so merging the outbox sends an existing consumer nothing
   * new. A webhook that lists events gets every cause mapped to one it lists.
   */
  legacyDefault: boolean;
  /** GitHub Actions repository_dispatch, which only those same two paths started. */
  githubActions: boolean;
  /**
   * Legacy unblocked-path quirk: a webhook without `events` was never filtered
   * by runnerPreference on this path. Kept so the default stays a no-op.
   */
  legacyUnfilteredRunnerPreference: boolean;
}

export function routeForCause(cause: DispatchCause): CauseRoute {
  switch (cause) {
    case 'task.created':
    case 'review.fix_requested':
    case 'ci.retry':
    case 'conflict.retry':
      return { event: 'task.created', legacyDefault: true, githubActions: true, legacyUnfilteredRunnerPreference: false };
    case 'plan_child.ready':
    case 'plan_child.created':
      return { event: 'task.created', legacyDefault: false, githubActions: false, legacyUnfilteredRunnerPreference: false };
    case 'dependency.satisfied':
    case 'manual.start':
      return { event: cause === 'manual.start' ? 'task.retry' : 'task.unblocked', legacyDefault: true, githubActions: true, legacyUnfilteredRunnerPreference: true };
    case 'path_claim.released':
    case 'budget.available':
    case 'credential.restored':
    case 'mission.released':
    case 'task.unblocked':
    case 'start_at.reached':
      return { event: 'task.unblocked', legacyDefault: false, githubActions: false, legacyUnfilteredRunnerPreference: false };
    case 'policy.requested':
      return { event: 'task.unblocked', legacyDefault: false, githubActions: false, legacyUnfilteredRunnerPreference: false };
    case 'task.requeued':
    case 'task.reassigned':
      return { event: 'task.retry', legacyDefault: false, githubActions: false, legacyUnfilteredRunnerPreference: false };
  }
}

/** Whether the webhook should be tried for this task and cause. Pure; `notHeldOrLocal` is pre-resolved. */
export function webhookWants(
  config: WorkspaceWebhookConfig | null | undefined,
  task: { runnerPreference?: string | null; startAt?: Date | string | null },
  route: CauseRoute,
  notHeldOrLocal: boolean,
  nowMs: number = Date.now(),
): boolean {
  if (!config?.enabled || !config.url) return false;
  const optedIn = Array.isArray(config.events);
  const subscribed = optedIn ? config.events!.includes(route.event) : route.legacyDefault;
  if (!subscribed) return false;
  const prefOk = (!optedIn && route.legacyUnfilteredRunnerPreference)
    || !config.runnerPreference
    || config.runnerPreference === 'any'
    || config.runnerPreference === (task.runnerPreference || 'any');
  if (!prefOk) return false;
  // A push consumer pays a cold start to learn the claim says "not yet".
  const deferred = task.startAt != null && new Date(task.startAt).getTime() > nowMs;
  if (deferred) return false;
  return notHeldOrLocal;
}

// ── Runner adapters ────────────────────────────────────────────────────────

const runnerPayload = (ctx: DispatchContext) => ({
  ...buildTaskPayload(ctx.task, ctx.workspace),
  dispatch: { id: ctx.dispatchId, cause: ctx.cause },
});

/**
 * A runner can only claim a pending task whose start time has come. A wake
 * for anything else is moot for every runner destination, so it closes here.
 * Another destination class would carry its own rule, not inherit this one.
 */
export const runnerClaimability: DispatchAdapter = {
  name: 'runner-claimability',
  async offer(ctx) {
    if (ctx.task.status !== 'pending') return { kind: 'skipped', why: `status_${ctx.task.status}` };
    if (ctx.task.startAt && new Date(ctx.task.startAt).getTime() > Date.now()) return { kind: 'skipped', why: 'start_at_future' };
    return DECLINED;
  },
};

/** An explicit "run it on this local runner" from creation (assignToLocalUiUrl). */
export const targetedLocalRunner: DispatchAdapter = {
  name: 'targeted-local-runner',
  async offer(ctx) {
    const targetLocalUiUrl = typeof ctx.metadata?.targetLocalUiUrl === 'string' ? ctx.metadata.targetLocalUiUrl : null;
    if (!targetLocalUiUrl) return DECLINED;
    const sent = await triggerEventChecked(channels.workspace(ctx.task.workspaceId), events.TASK_ASSIGNED, { task: runnerPayload(ctx), targetLocalUiUrl });
    if (sent === 'failed') throw new Error('pusher targeted assignment failed');
    return { kind: 'delivered', via: sent === 'sent' ? 'pusher:targeted' : 'pusher:unconfigured' };
  },
};

/** The workspace webhook (a push runner such as the Cloudflare dispatcher): the only exclusive consumer. */
export const workspaceWebhook: DispatchAdapter = {
  name: 'workspace-webhook',
  async offer(ctx) {
    const config = ctx.workspace.webhookConfig as WorkspaceWebhookConfig | null | undefined;
    const route = routeForCause(ctx.cause);
    // The held gate is a query; ask it only once the pure policy says yes.
    if (
      config
      && webhookWants(config, ctx.task, route, true)
      && await isTaskNotHeldOrLocal(ctx.task.id).catch(() => false)
      && await dispatchToWebhook(config, ctx.task, route.event, undefined, { cause: ctx.cause, dispatchId: ctx.dispatchId })
    ) {
      return { kind: 'delivered', via: 'webhook' };
    }
    return DECLINED;
  },
};

/**
 * GitHub Actions repository_dispatch. Supplementary: fires and always passes
 * the wake on. First attempt only — a retry (say the broadcast after it
 * failed) must not start another workflow run for the same intent.
 */
export const githubActions: DispatchAdapter = {
  name: 'github-actions',
  async offer(ctx) {
    if (ctx.attemptCount <= 1 && routeForCause(ctx.cause).githubActions) {
      tryGitHubActionsDispatch(ctx.workspace, ctx.task).catch(() => {});
    }
    return DECLINED;
  },
};

/** The broadcast every Pusher-connected runner hears. Terminal: it always takes the wake. */
export const runnerBroadcast: DispatchAdapter = {
  name: 'runner-broadcast',
  async offer(ctx) {
    const sent = await triggerEventChecked(channels.workspace(ctx.task.workspaceId), events.TASK_ASSIGNED, { task: runnerPayload(ctx), targetLocalUiUrl: null });
    if (sent === 'failed') throw new Error('pusher broadcast failed');
    return { kind: 'delivered', via: sent === 'sent' ? 'pusher' : 'pusher:unconfigured' };
  },
};

/**
 * Advance notice of a future work wake (`task.scheduled`, carrying
 * `notBefore`), for a webhook that lists that event: a push runner sets its
 * own timer instead of waiting on ours. Opt-in only, runnerPreference and the
 * held gate apply as for any webhook wake, and only within the consumer's
 * horizon. Not part of the chain — the chain delivers due intents; this is
 * offered when a future one is published to the timer. The intent is still
 * delivered when due, so a lost notice costs nothing but precision.
 */
export async function offerScheduledNotice(ctx: DispatchContext, notBefore: Date): Promise<boolean> {
  const config = ctx.workspace.webhookConfig as WorkspaceWebhookConfig | null | undefined;
  if (!config?.enabled || !config.url || !Array.isArray(config.events) || !config.events.includes('task.scheduled')) return false;
  if (ctx.task.status !== 'pending') return false;
  const ahead = notBefore.getTime() - Date.now();
  if (ahead <= 0 || ahead > SCHEDULED_DISPATCH_MAX_AHEAD_MS) return false;
  const prefOk = !config.runnerPreference || config.runnerPreference === 'any'
    || config.runnerPreference === (ctx.task.runnerPreference || 'any');
  if (!prefOk) return false;
  if (!(await isTaskNotHeldOrLocal(ctx.task.id).catch(() => false))) return false;
  return dispatchToWebhook(config, ctx.task, 'task.scheduled', undefined, {
    notBefore: notBefore.toISOString(), cause: ctx.cause, dispatchId: ctx.dispatchId,
  });
}

/** The `work_execution` chain: autonomous runners, push first, broadcast last. */
export const TASK_WAKE_ADAPTERS: readonly DispatchAdapter[] = [
  runnerClaimability,
  targetedLocalRunner,
  workspaceWebhook,
  githubActions,
  runnerBroadcast,
];

/**
 * The chain per intent kind. Only work execution has destinations today;
 * the others are registered here when their first adapter (an interactive
 * session, Slack/Teams, PagerDuty, a tracker) exists. Until then an intent of
 * that kind is parked as failed by the dispatcher — visible, not dropped.
 * A tracker adapter decides for itself what is worth materializing there; the
 * dispatcher never maps internal tasks or small human actions onto it.
 */
export const ADAPTER_CHAINS: Readonly<Partial<Record<DispatchIntent, readonly DispatchAdapter[]>>> = {
  work_execution: TASK_WAKE_ADAPTERS,
};
