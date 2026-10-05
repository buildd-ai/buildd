/**
 * Dispatch → Buildd callbacks: resolve (eligibility, payload and a
 * per-delivery grant before a webhook step) and relay (the
 * interim runner wake). Design: knowledge-base
 * buildd/design/cloudflare-dispatch-transport.md, "Adapter contract" and
 * "Removing each delivery dependency".
 *
 * Both run today's delivery logic through the same decision functions as the
 * in-app chain (lib/dispatch-adapters.ts), so AC-10…AC-18 hold on either
 * transport; dispatch-resolve.test.ts pins that with a parity table.
 *
 * A grant (the webhook bearer token) is returned in
 * the response only. It is never written to the database, a log line or an
 * error message here, and Dispatch holds it in memory for one step.
 */
import type { WorkspaceWebhookConfig } from '@buildd/core/db/schema';
import type { RelayRequest, RelayResponse, ResolveRequest, ResolveResponse } from '@buildd/dispatch-contract';
import { primaryCause } from '@buildd/core/dispatch-outbox';
import { parseTargetId, type DispatchTargetType } from '@buildd/core/dispatch-envelope';
import { claimCustody, inDispatchCustody, loadCustodyRow, type CustodyRow } from '@buildd/core/dispatch-handoff';
import {
  claimabilitySkip,
  sendRunnerWake,
  targetLocalUiUrlOf,
  webhookEligible,
  webhookPayloadFor,
  type DispatchContext,
} from '@/lib/dispatch-adapters';
import { loadForDelivery } from '@/lib/dispatch-authority';
import { tryLock } from '@/lib/redis';

/** Buildd refuses a second grant for the same (id, attempt, target) within this window. */
export const GRANT_ONCE_TTL_SEC = 300;

export interface CallbackResult<T> {
  status: number;
  body: T | { error: string };
}

export interface ResolveDeps {
  loadRow: (id: string) => Promise<CustodyRow | null>;
  /** Take custody of a published row whose ack has not landed yet; true if taken. */
  claimCustody: (id: string) => Promise<boolean>;
  loadTask: typeof loadForDelivery;
  /** SET NX: true = first mint in the window, false = already minted, null = could not ask. */
  grantOnce: (key: string, ttlSec: number) => Promise<boolean | null>;
  sendRunnerWake: typeof sendRunnerWake;
}

export const RESOLVE_DEPS: ResolveDeps = {
  loadRow: loadCustodyRow,
  claimCustody,
  loadTask: loadForDelivery,
  grantOnce: tryLock,
  sendRunnerWake,
};

// ── Shared preamble ────────────────────────────────────────────────────────

type Preamble =
  | { kind: 'error'; status: number; error: string }
  | { kind: 'moot'; why: string }
  | { kind: 'ok'; row: CustodyRow; ctx: DispatchContext; type: DispatchTargetType };

/**
 * Who may ask, about what: the target must name the row's own workspace, and
 * the row must be in Dispatch's custody (handed off, or a shadow row it
 * acked that the in-app drain has not delivered). A row that left custody
 * gets a well-formed "nothing to do" so Dispatch closes it, not a retry.
 */
async function preamble(
  req: { id?: unknown; attempt?: unknown; target?: unknown },
  allowed: readonly DispatchTargetType[],
  deps: ResolveDeps,
): Promise<Preamble> {
  if (typeof req.id !== 'string' || typeof req.attempt !== 'number' || !Number.isInteger(req.attempt) || req.attempt < 0) {
    return { kind: 'error', status: 400, error: 'id, attempt and target are required' };
  }
  const target = parseTargetId(req.target);
  if (!target) return { kind: 'error', status: 400, error: 'unknown target' };
  if (!allowed.includes(target.type)) {
    return { kind: 'error', status: 400, error: `${target.type} is not handled by this callback` };
  }
  let row = await deps.loadRow(req.id);
  if (!row) return { kind: 'error', status: 404, error: 'unknown dispatch id' };
  if (row.workspaceId.toLowerCase() !== target.workspaceId) return { kind: 'error', status: 403, error: 'target is outside this intent\'s scope' };
  // The callback can outrun the publish ack; take custody for it (claimCustodySql).
  if (!inDispatchCustody(row) && row.status === 'pending' && row.handedOffAt == null && await deps.claimCustody(row.id)) {
    row = (await deps.loadRow(req.id)) ?? row;
  }
  if (!inDispatchCustody(row)) return { kind: 'moot', why: `not_in_custody:${row.status}` };
  if (row.intent !== 'work_execution') return { kind: 'moot', why: `no_adapter:${row.intent}` };
  const loaded = await deps.loadTask(row.taskId);
  if (!loaded) return { kind: 'moot', why: 'task_gone' };
  const ctx: DispatchContext = {
    dispatchId: row.id,
    intent: row.intent,
    // 1 on the first delivery attempt, as the in-app chain counts.
    attemptCount: Math.max(1, req.attempt),
    cause: primaryCause(row.causes, row.cause),
    causes: row.causes,
    metadata: row.metadata,
    task: loaded.task,
    workspace: loaded.workspace,
  };
  return { kind: 'ok', row, ctx, type: target.type };
}

// ── Resolve ────────────────────────────────────────────────────────────────

/** True to proceed with a mint. Redis unconfigured or erroring fails open, with a log. */
async function firstGrant(deps: ResolveDeps, req: ResolveRequest): Promise<boolean> {
  const once = await deps.grantOnce(`buildd:dispatch:grant:${req.id}:${req.attempt}:${req.target}`, GRANT_ONCE_TTL_SEC);
  if (once === null) console.warn(`[dispatch-resolve] grant-once check unavailable (Redis); minting for ${req.id}`);
  return once !== false;
}

async function resolveWebhook(ctx: DispatchContext, req: ResolveRequest, deps: ResolveDeps): Promise<ResolveResponse> {
  // A future start_at skips, as in-app does: the outbox trigger always writes
  // a separate `start_at:<ms>` row due at that time, so rescheduling this one
  // too would deliver the webhook twice (two container cold starts).
  const skip = claimabilitySkip(ctx.task);
  if (skip) return { decision: 'skip', why: skip };
  if (targetLocalUiUrlOf(ctx.metadata)) return { decision: 'decline', why: 'targeted_local_runner' };
  if (!(await webhookEligible(ctx))) return { decision: 'decline', why: 'webhook_not_wanted' };
  const config = ctx.workspace.webhookConfig as WorkspaceWebhookConfig;
  if (!(await firstGrant(deps, req))) return { decision: 'decline', why: 'grant_already_issued' };
  return {
    decision: 'deliver',
    payload: webhookPayloadFor(ctx) as unknown as Record<string, unknown>,
    grant: { url: config.url, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` } },
  };
}

export async function resolveDispatch(req: ResolveRequest, deps: ResolveDeps = RESOLVE_DEPS): Promise<CallbackResult<ResolveResponse>> {
  const p = await preamble(req, ['webhook'], deps);
  if (p.kind === 'error') return { status: p.status, body: { error: p.error } };
  if (p.kind === 'moot') return { status: 200, body: { decision: 'skip', why: p.why } };
  const body = await resolveWebhook(p.ctx, req, deps);
  console.log(JSON.stringify({ event: 'dispatch_resolve', id: req.id, attempt: req.attempt, target: p.type, decision: body.decision, ...('why' in body ? { why: body.why } : {}) }));
  return { status: 200, body };
}

// ── Relay ──────────────────────────────────────────────────────────────────

/**
 * The interim runner wake: the same claimability rule and the same Pusher
 * send as the in-app chain. `failed` is a 502 so Dispatch retries with its
 * backoff; `unconfigured` closes the intent (no live listener to miss it).
 */
export async function relayDispatch(req: RelayRequest, deps: ResolveDeps = RESOLVE_DEPS): Promise<CallbackResult<RelayResponse>> {
  const p = await preamble(req, ['runner-wake'], deps);
  if (p.kind === 'error') return { status: p.status, body: { error: p.error } };
  if (p.kind === 'moot') return { status: 200, body: { outcome: 'skipped', why: p.why } };
  const skip = claimabilitySkip(p.ctx.task);
  if (skip) return { status: 200, body: { outcome: 'skipped', why: skip } };
  const fromPayload = typeof req.payload?.targetLocalUiUrl === 'string' ? req.payload.targetLocalUiUrl : null;
  const targeted = fromPayload ?? targetLocalUiUrlOf(p.row.metadata);
  const sent = await deps.sendRunnerWake(p.ctx, targeted);
  if (sent === 'failed') return { status: 502, body: { error: 'pusher send failed' } };
  if (sent === 'unconfigured') return { status: 200, body: { outcome: 'skipped', why: 'pusher_unconfigured' } };
  return { status: 200, body: { outcome: 'delivered', via: targeted ? 'relay:pusher:targeted' : 'relay:pusher' } };
}
