/**
 * Effects behind a landing tap. Every action reuses the door that already
 * exists for it (retry-ci, re-review, merge, the conflict dispatcher) rather
 * than growing a parallel path; this file only translates their replies.
 */

import { NextRequest } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import type { LandingAction } from '@/lib/landing-action-token';
import {
  runLandingAction,
  describeLandingAction,
  fromDispatchRoute,
  fromMergeRoute,
  type ActionContext,
  type ActionResult,
  type LandingActionDeps,
  type TapInput,
  type TapOutcome,
  type LandingActionView,
} from '@/lib/landing-action';
import {
  claimActionNonce,
  readActionRecord,
  releaseActionNonce,
  resetRefreshBudget,
  settleActionNonce,
} from '@/lib/pr-landing-alert-deps';
import { LANDING_ACTION_LABELS } from '@/lib/pr-landing-alert';

type RouteName = 'retry-ci' | 're-review' | 'merge';
type RouteReply = { status: number; json: Record<string, any> };

export interface LandingRunPorts {
  /** Call one of the PR routes in-process, as the signed-in person. */
  callRoute: (name: RouteName, prNumber: number, body: Record<string, unknown>) => Promise<RouteReply>;
  dispatchConflict: (ctx: ActionContext) => Promise<{
    dispatched: boolean;
    taskId?: string;
    superseded?: boolean;
    dependencyBot?: boolean;
    baseRewritten?: boolean;
    inFlightTaskId?: string;
    branchUpdated?: boolean;
  }>;
  closePr: (ctx: ActionContext) => Promise<void>;
  resetBudget: (taskId: string) => Promise<void>;
}

export function makeLandingRunner(ports: LandingRunPorts): LandingActionDeps['run'] {
  return async (action: LandingAction, ctx: ActionContext): Promise<ActionResult> => {
    const body = { workspaceId: ctx.workspaceId };
    switch (action) {
      case 'ci_fix':
        return fromDispatchRoute('CI fix', await ports.callRoute('retry-ci', ctx.prNumber, body));
      case 're_review':
        return fromDispatchRoute('Re-review', await ports.callRoute('re-review', ctx.prNumber, body));
      case 'conflict': {
        const r = await ports.dispatchConflict(ctx);
        if (r.superseded) return { ok: false, error: 'The change is already upstream; close the PR as superseded instead.' };
        if (r.dependencyBot) return { ok: false, error: 'This is a dependency bot PR; it needs a person.' };
        if (r.baseRewritten) return { ok: false, error: 'The base branch was rewritten; it needs a person.' };
        if (r.branchUpdated) return { ok: true, summary: 'The branch was updated; it merges when CI is green.', taskId: null };
        if (r.inFlightTaskId) return { ok: true, summary: 'Conflict resolution is already in progress.', taskId: r.inFlightTaskId };
        if (r.dispatched) return { ok: true, summary: 'Conflict resolution dispatched.', taskId: r.taskId ?? null };
        return { ok: false, error: 'Conflict resolution could not be dispatched.' };
      }
      case 'retry_landing':
        await ports.resetBudget(ctx.taskId);
        return fromMergeRoute(await ports.callRoute('merge', ctx.prNumber, { ...body, overrides: {} }));
      case 'merge_anyway':
        return fromMergeRoute(await ports.callRoute('merge', ctx.prNumber, { ...body, overrides: ctx.override ?? {} }));
      case 'close_superseded':
        await ports.closePr(ctx);
        return { ok: true, summary: 'Closed as superseded.', taskId: null };
      case 'review_on_github':
        // A link the page opens; runLandingAction refuses it before it gets here.
        return { ok: false, error: 'Review and merge this PR on GitHub.' };
    }
  };
}

async function repoFor(workspaceId: string): Promise<{ installationId: number; repoFullName: string } | null> {
  const ws = (await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    with: { githubRepo: { with: { installation: true } } },
  })) as any;
  const installationId = ws?.githubRepo?.installation?.installationId;
  const repoFullName = ws?.githubRepo?.fullName;
  return installationId && repoFullName ? { installationId, repoFullName } : null;
}

const defaultPorts: LandingRunPorts = {
  async callRoute(name, prNumber, body) {
    const req = new NextRequest(`http://internal/api/prs/${prNumber}/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const params = { params: Promise.resolve({ prNumber: String(prNumber) }) };
    const mod =
      name === 'retry-ci'
        ? await import('@/app/api/prs/[prNumber]/retry-ci/route')
        : name === 're-review'
          ? await import('@/app/api/prs/[prNumber]/re-review/route')
          : await import('@/app/api/prs/[prNumber]/merge/route');
    const res = await mod.POST(req, params);
    return { status: res.status, json: await res.json().catch(() => ({})) };
  },
  async dispatchConflict(ctx) {
    const repo = await repoFor(ctx.workspaceId);
    if (!repo) return { dispatched: false };
    const { dispatchConflictRetry } = await import('@/lib/conflict-retry');
    return dispatchConflictRetry({
      workerId: ctx.workerId,
      taskId: ctx.taskId,
      prNumber: ctx.prNumber,
      headSha: ctx.headSha,
      repoFullName: repo.repoFullName,
      workspaceId: ctx.workspaceId,
      humanInitiated: true,
    });
  },
  async closePr(ctx) {
    const repo = await repoFor(ctx.workspaceId);
    if (!repo) throw new Error('Workspace has no GitHub installation');
    const { githubApi } = await import('@/lib/github');
    await githubApi(repo.installationId, `/repos/${repo.repoFullName}/pulls/${ctx.prNumber}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'closed' }),
    });
  },
  resetBudget: resetRefreshBudget,
};

async function readLiveHead({ workspaceId, prNumber }: { workspaceId: string; prNumber: number }): Promise<string | null> {
  const repo = await repoFor(workspaceId);
  if (!repo) return null;
  const { githubApi } = await import('@/lib/github');
  const pr = (await githubApi(repo.installationId, `/repos/${repo.repoFullName}/pulls/${prNumber}`)) as { head?: { sha?: string } } | null;
  return pr?.head?.sha ?? null;
}

export const landingActionDeps: LandingActionDeps = {
  now: () => Date.now(),
  claimNonce: claimActionNonce,
  readNonce: readActionRecord,
  settleNonce: settleActionNonce,
  releaseNonce: releaseActionNonce,
  readLiveHead,
  run: makeLandingRunner(defaultPorts),
};

export const performLandingAction = (input: TapInput): Promise<TapOutcome> => runLandingAction(input, landingActionDeps);

export const loadLandingActionView = (
  input: Pick<TapInput, 'token' | 'workspaceId' | 'prNumber' | 'taskId'>,
): Promise<LandingActionView> => describeLandingAction(input, landingActionDeps);

export { LANDING_ACTION_LABELS };
