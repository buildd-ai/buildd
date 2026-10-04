/**
 * Buildd → Dispatch: route policy at publish time, and the publish client.
 * Design: knowledge-base buildd/design/cloudflare-dispatch-transport.md
 * ("Handoff", "Envelope"); contract: docs/specs/task-dispatch-authority.md,
 * "Dispatch transport (P0)".
 *
 * Gated twice, so the default is a no-op: nothing is read or sent unless
 * DISPATCH_URL and DISPATCH_PUBLISH_SECRET are set, and only rows of
 * workspaces whose `dispatch_transport` is `shadow` or `dispatch` are taken.
 *
 * Dispatch moves envelopes; Buildd decides what they mean. `routeFor` only
 * says which destinations are worth trying, using the same policy the in-app
 * chain uses (lib/dispatch-adapters.ts). The final say for a webhook or
 * GitHub Actions step is the resolve callback at delivery time
 * (lib/dispatch-resolve.ts), and for a runner wake it is the claim route.
 */
import { db } from '@buildd/core/db';
import { tasks, type WorkspaceWebhookConfig } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import {
  MAX_PUBLISH_BATCH,
  parseKeyRing,
  signingKey,
  signRequest,
  type PublishRequest,
  type PublishResponse,
  type PublishResult,
  type RouteStep,
} from '@buildd/dispatch-contract';
import { primaryCause } from '@buildd/core/dispatch-outbox';
import { targetId, toEnvelope, type EnvelopeRoute } from '@buildd/core/dispatch-envelope';
import {
  ackHandoff,
  ackMerged,
  selectForPublish,
  PUBLISH_SWEEP_LIMIT,
  type Ack,
  type MergedAck,
  type PublishableRow,
} from '@buildd/core/dispatch-handoff';
import { routeForCause, targetLocalUiUrlOf, webhookWants, type DispatchContext } from '@/lib/dispatch-adapters';
import { isGitHubAppConfigured } from '@/lib/github';
import type { DispatchWorkspace } from '@/lib/task-dispatch-delivery';

/** The publish is awaited this long; a slower Worker costs one sweep, not the request. */
export const PUBLISH_TIMEOUT_MS = 2_000;

export interface DispatchTransportConfig {
  url: string;
  key: { keyId: string; secret: string };
}

/** Null (transport off) unless both the URL and a signing key are configured. */
export function dispatchTransportConfig(env: Record<string, string | undefined> = process.env): DispatchTransportConfig | null {
  const url = env.DISPATCH_URL?.trim();
  const key = signingKey(parseKeyRing(env.DISPATCH_PUBLISH_SECRET));
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key };
}

// ── Route policy ───────────────────────────────────────────────────────────

type RouteTask = DispatchContext['task'];

/**
 * The inline runner-wake payload: enough for a runner to resolve the
 * workspace and pick a claim context before claiming, and no task title or
 * description (it sits at rest in Dispatch).
 */
export function runnerWakePayload(row: Pick<PublishableRow, 'id'>, task: Pick<RouteTask, 'id' | 'workspaceId' | 'backend'>, workspace: DispatchWorkspace) {
  return {
    taskId: task.id,
    workspaceId: task.workspaceId,
    backend: task.backend ?? null,
    ...(workspace.name ? { workspace: { name: workspace.name, repo: workspace.repo ?? null } } : {}),
    dispatchId: row.id,
  };
}

/**
 * Which destinations an envelope should try, in today's chain order
 * (dispatch-adapters.ts TASK_WAKE_ADAPTERS), decided with the chain's own
 * policy functions:
 *
 *  - a `targetLocalUiUrl` hint → only the runner wake, targeted (AC-15);
 *  - the webhook, `first` + resolve, when `webhookWants` would take this
 *    cause from this workspace (startAt and the held gate are judged at
 *    resolve time, when the wake is due);
 *  - GitHub Actions, `also` + resolve, for the legacy causes on an intent's
 *    first attempt when the workspace is linked and the App configured;
 *  - the runner wake, `first`, always last (the terminal broadcast).
 *
 * Null for a non-work intent: no adapter exists for those kinds, so they are
 * never published and the in-app drain parks them as `no_adapter`, as today.
 */
export function routeFor(row: PublishableRow, task: RouteTask, workspace: DispatchWorkspace): EnvelopeRoute | null {
  if (row.intent !== 'work_execution') return null;
  const wake: RouteStep = { target: targetId(row.workspaceId, 'runner-wake'), mode: 'first' };
  const payload = runnerWakePayload(row, task, workspace);
  const targeted = targetLocalUiUrlOf(row.metadata);
  if (targeted) return { steps: [wake], payload: { ...payload, targetLocalUiUrl: targeted } };

  const route = routeForCause(primaryCause(row.causes, row.cause));
  const steps: RouteStep[] = [];
  const config = workspace.webhookConfig as WorkspaceWebhookConfig | null | undefined;
  if (config && webhookWants(config, { ...task, startAt: null }, route, true)) {
    steps.push({ target: targetId(row.workspaceId, 'webhook'), mode: 'first', resolve: true });
  }
  if (row.attemptCount === 0 && route.githubActions && workspace.githubInstallationId && workspace.githubRepoId && isGitHubAppConfigured()) {
    steps.push({ target: targetId(row.workspaceId, 'github-actions'), mode: 'also', resolve: true });
  }
  steps.push(wake);
  return { steps, payload };
}

// ── Publish ────────────────────────────────────────────────────────────────

export type PublishOutcome =
  | { status: 'unconfigured' }
  | { status: 'idle' }
  | { status: 'failed'; published: number; error: string }
  | { status: 'ok'; published: number; acked: number; merged: number; rejected: number };

interface RouteContext { task: RouteTask; workspace: DispatchWorkspace }

async function loadRouteContext(taskIds: string[]): Promise<Map<string, RouteContext>> {
  const found = await db.query.tasks.findMany({
    where: inArray(tasks.id, taskIds),
    columns: {
      id: true, title: true, description: true, workspaceId: true, mode: true, priority: true,
      missionId: true, backend: true, roleSlug: true, runnerPreference: true, status: true, startAt: true,
    },
    with: {
      workspace: {
        columns: { id: true, name: true, repo: true, webhookConfig: true, githubInstallationId: true, githubRepoId: true },
      },
    },
  });
  const out = new Map<string, RouteContext>();
  for (const row of found) {
    const { workspace, ...task } = row as typeof row & { workspace: DispatchWorkspace };
    out.set(task.id, { task: task as RouteTask, workspace: workspace ?? {} });
  }
  return out;
}

export interface PublishDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  selectForPublish: typeof selectForPublish;
  ackHandoff: typeof ackHandoff;
  ackMerged: typeof ackMerged;
  loadRouteContext: (taskIds: string[]) => Promise<Map<string, RouteContext>>;
}

const DEFAULT_DEPS: PublishDeps = { fetch: (url, init) => fetch(url, init), selectForPublish, ackHandoff, ackMerged, loadRouteContext };

/**
 * Publish unacked rows to Dispatch and ack what it accepted. This task's rows
 * go first, then up to `limit` of the oldest others: every publish is also a
 * repair sweep. Selecting stamps `published_at`, so a row is not re-sent for
 * PUBLISH_BACKOFF_MS whatever happens to this request.
 *
 * Never throws. A failure leaves the rows pending and unacked: the next
 * publish anywhere retries them, and past PUBLISH_GRACE_MS the in-app drain
 * delivers them instead.
 */
export async function publishPendingDispatches(
  opts: { taskId?: string; limit?: number; timeoutMs?: number } = {},
  deps: Partial<PublishDeps> = {},
): Promise<PublishOutcome> {
  const config = dispatchTransportConfig();
  if (!config) return { status: 'unconfigured' };
  const d = { ...DEFAULT_DEPS, ...deps };
  let published = 0;
  try {
    const limit = Math.min(opts.limit ?? PUBLISH_SWEEP_LIMIT, MAX_PUBLISH_BATCH);
    const rows = await d.selectForPublish({ taskId: opts.taskId, limit });
    if (rows.length === 0) return { status: 'idle' };

    const ctx = await d.loadRouteContext([...new Set(rows.map(r => r.taskId))]);
    const now = Date.now();
    const sendable: Array<{ row: PublishableRow; envelope: ReturnType<typeof toEnvelope> }> = [];
    for (const row of rows) {
      const c = ctx.get(row.taskId);
      const route = c && routeFor(row, c.task, c.workspace);
      if (route) sendable.push({ row, envelope: toEnvelope(row, route, { now }) });
    }
    if (sendable.length === 0) return { status: 'idle' };
    published = sendable.length;

    const url = `${config.url}/v1/envelopes`;
    const u = new URL(url);
    const body = JSON.stringify({ envelopes: sendable.map(s => s.envelope) } satisfies PublishRequest);
    const signed = await signRequest({ ...config.key, method: 'POST', path: u.pathname + u.search, body });
    const res = await d.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...signed },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? PUBLISH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      console.error(`[dispatch-transport] publish refused: HTTP ${res.status} ${detail}`);
      return { status: 'failed', published, error: `http_${res.status}` };
    }
    const parsed = await res.json() as PublishResponse;
    const results: PublishResult[] = Array.isArray(parsed?.results) ? parsed.results : [];

    const modeById = new Map(sendable.map(s => [s.row.id, s.row.mode]));
    const acks: Ack[] = [];
    const merges: MergedAck[] = [];
    let rejected = 0;
    for (const r of results) {
      const mode = modeById.get(r?.id);
      if (!mode) continue;
      if (r.status === 'accepted' || r.status === 'duplicate') acks.push({ id: r.id, mode });
      else if (r.status === 'merged') merges.push({ id: r.id, mode, into: r.into });
      else if (r.status === 'rejected') {
        rejected++;
        console.warn(`[dispatch-transport] envelope ${r.id} rejected: ${r.why}`);
      }
    }
    const [acked, merged] = await Promise.all([d.ackHandoff(acks), d.ackMerged(merges)]);
    console.log(JSON.stringify({ event: 'dispatch_publish', published, acked, merged, rejected }));
    // `acked`/`merged` count rows the ack actually moved: a row the in-app
    // fallback took meanwhile, or a duplicate ack, is not counted.
    return { status: 'ok', published, acked, merged, rejected };
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`[dispatch-transport] publish failed: ${msg}`);
    return { status: 'failed', published, error: msg.slice(0, 200) };
  }
}
