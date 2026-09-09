/**
 * The one path that dispatches a release workflow AND records it.
 *
 * Before this, four call sites dispatched `workflow_dispatch` releases and only
 * ONE of them wrote a `releases` row:
 *
 *   - `POST /api/releases/trigger` — inserted a row, read the run back, attributed tasks
 *   - the github webhook's `every_merge` branch — dispatched, wrote only `tasks.releaseResult`
 *   - the webhook's `on_mission_complete` branch — same
 *   - `fireMissionReleaseIfComplete` — a raw dispatch with no readback at all
 *
 * The consequence was not a missing nicety. For a `gated` + `workflow_dispatch`
 * workspace — which is what this repo's own workspace is — an `auto` release row
 * is structurally impossible: every automatic entry point into
 * `maybeCreateReleaseRow` filters on strategy `branch_merge` first. So the
 * Releases page, the queue baseline, task→release attribution and the
 * release-health cron were all blind to the releases that actually shipped.
 * Production shipped four release PRs in one day against zero new rows.
 *
 * Everything here is best-effort about GitHub and strict about the row: a
 * release that cannot resolve a head sha is refused rather than recorded
 * without a commit range, because a row with no range cannot be attributed,
 * cannot be sha-verified, and cannot be matched back to its workflow run.
 */

import { db as defaultDb } from '@buildd/core/db';
import { releases } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { githubApi as defaultGithubApi } from '@/lib/github';
import { dispatchWorkflowRelease, releasePreflight } from '@/lib/release/dispatch';
import { attributeRelease } from '@buildd/core/release-attribution';
import type { ReleaseArchetype } from '@buildd/core/release-archetype';

export interface RecordAndDispatchParams {
  workspaceId: string;
  archetype: ReleaseArchetype;
  installationId: number;
  owner: string;
  name: string;
  repoFullName: string;
  workflowFile: string;
  /** Git ref the release workflow runs on (the source branch). */
  ref: string;
  /** Branch the release lands on; used to compute the commit range. */
  prodBranch: string;
  inputs: Record<string, string>;
  triggeredBy: 'user' | 'agent' | 'auto';
  /** Re-dispatch a commit that already has a row in any state. */
  force?: boolean;
}

export type RecordAndDispatchResult =
  | {
      ok: true;
      releaseId: string;
      /** True when an in-flight row for this commit already existed; nothing was dispatched. */
      deduped: boolean;
      headSha: string;
      runId?: number;
      runUrl?: string;
      runsUrl?: string;
    }
  | { ok: false; status: number; error: string; releaseId?: string };

/** Seam for tests; production always uses the real modules. */
export interface RecordAndDispatchDeps {
  db?: typeof defaultDb;
  githubApi?: typeof defaultGithubApi;
  dispatch?: typeof dispatchWorkflowRelease;
  preflight?: typeof releasePreflight;
  attribute?: typeof attributeRelease;
}

export async function recordAndDispatchRelease(
  params: RecordAndDispatchParams,
  deps: RecordAndDispatchDeps = {},
): Promise<RecordAndDispatchResult> {
  const db = deps.db ?? defaultDb;
  const githubApi = deps.githubApi ?? defaultGithubApi;
  const dispatch = deps.dispatch ?? dispatchWorkflowRelease;
  const preflight = deps.preflight ?? releasePreflight;
  const attribute = deps.attribute ?? attributeRelease;

  const { workspaceId, archetype, installationId, owner, name, ref, prodBranch } = params;

  // T1 readiness data, best-effort: a GitHub hiccup must not stop the release.
  let headSha: string | undefined;
  let previousSha: string | undefined;
  let ciStateAtDispatch: 'passing' | 'failing' | 'pending' | undefined;
  let commitsAheadAtDispatch: number | undefined;

  try {
    const pre = await preflight(installationId, owner, name, { ref, prodBranch });
    headSha = pre.refHeadSha;
    previousSha = pre.previousSha;
    if (pre.ciState && pre.ciState !== 'unknown') ciStateAtDispatch = pre.ciState;
    commitsAheadAtDispatch = pre.aheadBy;
  } catch {
    // fall through to the direct ref lookup below
  }

  // A compare with zero commits ahead leaves refHeadSha undefined (it is derived
  // from the commit range, not the ref), and so does a thrown preflight.
  if (!headSha) {
    try {
      const refObj = await githubApi(installationId, `/repos/${owner}/${name}/git/ref/heads/${ref}`);
      headSha = refObj?.object?.sha as string | undefined;
    } catch {
      // refused below
    }
  }

  if (!headSha) {
    return {
      ok: false,
      status: 422,
      error: `Could not resolve the head commit of ${ref} — refusing to dispatch a release with no head sha.`,
    };
  }

  // Idempotency: an in-flight row for this commit means a release is already
  // under way. `force` explicitly asks to re-dispatch it anyway.
  if (!params.force) {
    const existing = await db.query.releases.findFirst({
      where: and(
        eq(releases.workspaceId, workspaceId),
        eq(releases.headSha, headSha),
        inArray(releases.state, ['dispatched', 'deploying']),
      ),
    });
    if (existing) {
      return { ok: true, releaseId: existing.id, deduped: true, headSha };
    }
  }

  const releaseValues = {
    workspaceId,
    archetype,
    headSha,
    previousSha,
    state: 'dispatched' as const,
    verificationStrategy: (archetype === 'gated' ? 'http' : 'none') as 'http' | 'none',
    triggeredBy: params.triggeredBy,
    dispatchedAt: new Date(),
    ciStateAtDispatch,
    commitsAheadAtDispatch,
  };

  // The row is written BEFORE the dispatch, so a dispatch that fails still
  // leaves a record of the attempt. `force` may collide with a row in any
  // state — including terminal ones the dedup check above ignores — so it
  // upserts rather than raising a bare unique violation, clearing the prior
  // lifecycle fields so a stale healthy/failed run cannot bleed through.
  const [releaseRow] = params.force
    ? await db
        .insert(releases)
        .values(releaseValues)
        .onConflictDoUpdate({
          target: [releases.workspaceId, releases.headSha],
          set: {
            ...releaseValues,
            runUrl: null,
            deployUrl: null,
            deployedAt: null,
            healthyAt: null,
            failureReason: null,
          },
        })
        .returning({ id: releases.id })
    : await db
        .insert(releases)
        .values(releaseValues)
        // A row for this commit in a TERMINAL state is not an in-flight
        // release, so the dedup check above lets it through — and a plain
        // insert would then raise 23505 and surface as an opaque 500. Re-arm
        // the existing row instead: this is a genuine re-release of the commit.
        .onConflictDoUpdate({
          target: [releases.workspaceId, releases.headSha],
          set: {
            ...releaseValues,
            runUrl: null,
            deployUrl: null,
            deployedAt: null,
            healthyAt: null,
            failureReason: null,
          },
        })
        .returning({ id: releases.id });

  const releaseId = releaseRow.id;

  let dispatchResult: Awaited<ReturnType<typeof dispatchWorkflowRelease>>;
  try {
    dispatchResult = await dispatch(installationId, owner, name, {
      workflowFile: params.workflowFile,
      ref,
      inputs: params.inputs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The row stays, carrying why — a dispatch that never happened is still
    // part of this commit's release history.
    await db
      .update(releases)
      .set({ state: 'failed', failureReason: `dispatch failed: ${message}` })
      .where(and(eq(releases.id, releaseId), eq(releases.state, 'dispatched')));
    return { ok: false, status: 502, error: message, releaseId };
  }

  if (dispatchResult.runUrl) {
    await db.update(releases).set({ runUrl: dispatchResult.runUrl }).where(eq(releases.id, releaseId));
  }

  // Attribution needs a commit range. It is awaited rather than fire-and-forget:
  // in a serverless handler a `void`-ed promise races the freeze, and the
  // trigger route's un-caught version left 8 of 13 production rows with zero
  // task edges.
  if (previousSha) {
    try {
      await attribute({
        releaseId,
        workspaceId,
        previousSha,
        headSha,
        archetype,
        repoFullName: params.repoFullName,
        githubInstallationId: installationId,
        db: db as any,
      });
    } catch (err) {
      console.error(`[release-record] attribution failed for release ${releaseId}:`, err);
    }
  }

  return {
    ok: true,
    releaseId,
    deduped: false,
    headSha,
    runId: dispatchResult.runId,
    runUrl: dispatchResult.runUrl,
    runsUrl: dispatchResult.runsUrl,
  };
}
