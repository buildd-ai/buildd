/**
 * What a tap on the landing page does (knowledge-base: buildd/design/pr-landing-guarantee.md §H).
 *
 * The signed link only selects an action; the route that calls this has already
 * required a signed-in member of the PR's workspace. Here: verify the token,
 * confirm it is for this PR, spend its nonce exactly once, and run the one
 * action. A head that moved since the page was sent re-runs landing instead of
 * acting on stale advice. Effects are injected (`landing-action-run.ts`).
 */

import { verifyLandingActionToken, type LandingAction } from '@/lib/landing-action-token';
import { actionsForReason, overrideForAction } from '@/lib/pr-landing-alert';
import type { ActionRecord } from '@/lib/pr-landing-alert-deps';

export interface ActionContext {
  workspaceId: string;
  prNumber: number;
  taskId: string;
  workerId: string;
  /** The live head the action runs against (not necessarily the one the page was sent for). */
  headSha: string;
  reason: string;
  override: { verdict?: boolean; size?: boolean; freshness?: boolean } | null;
}

export type ActionResult =
  | { ok: true; summary: string; taskId?: string | null; outcome?: string }
  | { ok: false; error: string };

export interface LandingActionDeps {
  now: () => number;
  claimNonce: (taskId: string, nonce: string, record: ActionRecord) => Promise<boolean>;
  readNonce: (taskId: string, nonce: string) => Promise<ActionRecord | null>;
  settleNonce: (taskId: string, nonce: string, record: ActionRecord) => Promise<void>;
  releaseNonce: (taskId: string, nonce: string) => Promise<void>;
  readLiveHead: (ctx: { workspaceId: string; prNumber: number }) => Promise<string | null>;
  run: (action: LandingAction, ctx: ActionContext) => Promise<ActionResult>;
}

export interface TapInput {
  token: string;
  /** The option picked on the confirm screen; defaults to the one the page was sent for. */
  action?: LandingAction;
  /** From the session-resolved PR owner, never from the token. */
  workspaceId: string;
  prNumber: number;
  taskId: string;
  workerId: string;
}

export type TapOutcome =
  | { status: 'rejected'; code: 'expired' | 'invalid' | 'mismatch' | 'bad_action'; httpStatus: 400 | 403 | 410 }
  | { status: 'in_progress' }
  | { status: 'already_done'; result: StoredResult }
  | { status: 'done'; ok: true; stale: boolean; liveHeadSha: string | null; result: StoredResult }
  | { status: 'done'; ok: false; stale: boolean; error: string };

export interface StoredResult {
  action: LandingAction;
  summary: string;
  taskId?: string | null;
  outcome?: string;
  stale?: boolean;
}

export async function runLandingAction(input: TapInput, deps: LandingActionDeps): Promise<TapOutcome> {
  const verdict = verifyLandingActionToken(input.token, deps.now());
  if (!verdict.ok) {
    return verdict.reason === 'expired'
      ? { status: 'rejected', code: 'expired', httpStatus: 410 }
      : { status: 'rejected', code: 'invalid', httpStatus: 400 };
  }
  const { payload } = verdict;
  if (payload.workspaceId !== input.workspaceId || payload.prNumber !== input.prNumber) {
    return { status: 'rejected', code: 'mismatch', httpStatus: 403 };
  }

  const plan = actionsForReason(payload.reason);
  const chosen = input.action ?? payload.action;
  if (!plan.options.includes(chosen)) return { status: 'rejected', code: 'bad_action', httpStatus: 400 };
  const override = overrideForAction(payload.reason, chosen);
  if (!override) return { status: 'rejected', code: 'bad_action', httpStatus: 400 };

  const claimed = await deps.claimNonce(input.taskId, payload.nonce, { status: 'claimed', at: new Date(deps.now()).toISOString(), action: chosen });
  if (!claimed) {
    const existing = await deps.readNonce(input.taskId, payload.nonce);
    if (existing?.status === 'done' && existing.result) return { status: 'already_done', result: existing.result as unknown as StoredResult };
    return { status: 'in_progress' };
  }

  let stale = false;
  let action = chosen;
  let headSha = payload.headSha;
  try {
    const live = await deps.readLiveHead({ workspaceId: input.workspaceId, prNumber: input.prNumber });
    if (!live || live !== payload.headSha) {
      stale = true;
      action = 'retry_landing';
      headSha = live ?? payload.headSha;
    }
    const res = await deps.run(action, {
      workspaceId: input.workspaceId,
      prNumber: input.prNumber,
      taskId: input.taskId,
      workerId: input.workerId,
      headSha,
      reason: payload.reason,
      override: stale ? {} : override,
    });
    if (!res.ok) {
      await deps.releaseNonce(input.taskId, payload.nonce).catch(() => {});
      return { status: 'done', ok: false, stale, error: res.error };
    }
    const result: StoredResult = { action, summary: res.summary, taskId: res.taskId ?? null, ...(res.outcome ? { outcome: res.outcome } : {}), ...(stale ? { stale } : {}) };
    await deps.settleNonce(input.taskId, payload.nonce, {
      status: 'done',
      at: new Date(deps.now()).toISOString(),
      action,
      result: result as unknown as Record<string, unknown>,
    });
    return { status: 'done', ok: true, stale, liveHeadSha: stale ? headSha : null, result };
  } catch (err) {
    await deps.releaseNonce(input.taskId, payload.nonce).catch(() => {});
    return { status: 'done', ok: false, stale, error: err instanceof Error ? err.message : 'the action failed' };
  }
}

export type LandingActionView =
  | { state: 'invalid' | 'expired' | 'mismatch' }
  | { state: 'already_done'; result: StoredResult }
  | {
      state: 'ready';
      reason: string;
      proposed: LandingAction;
      options: LandingAction[];
      headSha: string;
      headMoved: boolean;
    };

/** What the confirm screen shows. Spends nothing: only the confirm POST consumes the link. */
export async function describeLandingAction(
  input: Pick<TapInput, 'token' | 'workspaceId' | 'prNumber' | 'taskId'>,
  deps: Pick<LandingActionDeps, 'now' | 'readNonce' | 'readLiveHead'>,
): Promise<LandingActionView> {
  const verdict = verifyLandingActionToken(input.token, deps.now());
  if (!verdict.ok) return { state: verdict.reason === 'expired' ? 'expired' : 'invalid' };
  const { payload } = verdict;
  if (payload.workspaceId !== input.workspaceId || payload.prNumber !== input.prNumber) return { state: 'mismatch' };

  const rec = await deps.readNonce(input.taskId, payload.nonce);
  if (rec?.status === 'done' && rec.result) return { state: 'already_done', result: rec.result as unknown as StoredResult };

  const plan = actionsForReason(payload.reason);
  const live = await deps.readLiveHead({ workspaceId: input.workspaceId, prNumber: input.prNumber }).catch(() => null);
  return {
    state: 'ready',
    reason: payload.reason,
    proposed: plan.options.includes(payload.action) ? payload.action : plan.primary,
    options: plan.options,
    headSha: payload.headSha,
    headMoved: !live || live !== payload.headSha,
  };
}

// ── Mapping an existing route's reply onto an ActionResult ─────────────────────

type RouteReply = { status: number; json: Record<string, any> };
const asString = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** A fix-dispatching route (retry-ci, re-review): it either filed (or found live) a task, or refused. */
export function fromDispatchRoute(label: string, reply: RouteReply): ActionResult {
  const { status, json } = reply;
  if (status >= 200 && status < 300 && json.ok !== false) {
    const taskId = asString(json.taskId) ?? asString(json.reviewTaskId);
    if (json.carriedForward) return { ok: true, summary: 'The earlier approval carries to the new commit.', taskId: null };
    const already = json.inFlight || json.alreadyRequested || json.dispatched === false;
    return { ok: true, summary: already ? `${label} is already in progress.` : `${label} dispatched.`, taskId };
  }
  return { ok: false, error: asString(json.error) ?? `${label} could not be dispatched (${status}).` };
}

/**
 * The dashboard merge route is the landing door: a refusal that still carries a
 * landing outcome is the landing function answering, not the action failing.
 */
export function fromMergeRoute(reply: RouteReply): ActionResult {
  const { status, json } = reply;
  if (status >= 200 && status < 300 && json.ok !== false && json.merged !== false) return { ok: true, summary: 'Merged.', outcome: 'merged' };
  if (status === 202) return { ok: true, summary: asString(json.message) ?? 'The branch was updated; it merges when CI is green.', outcome: 'updating_branch' };
  const landing = json.landing as { kind?: string } | undefined;
  if (landing?.kind) return { ok: true, summary: asString(json.error) ?? 'Landing re-ran and is still waiting.', outcome: landing.kind };
  return { ok: false, error: asString(json.error) ?? `The merge could not be attempted (${status}).` };
}
