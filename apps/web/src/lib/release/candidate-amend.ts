/**
 * When the dev-side fix for a red frozen release candidate merges, amend the
 * candidate: dispatch the release workflow once with `amend` / `amend_confirm`
 * and say so on the candidate PR.
 *
 * The fix task is filed by `retryCiFailureForPr` (lib/release-candidate-ci.ts)
 * and carries `context.releaseCandidateFix`. Its PR merging into the candidate's
 * source branch is the signal; nothing else dispatches the amendment.
 *
 * Idempotent per fix PR: a compare-and-set marker on the fix task is claimed
 * before the dispatch (a redelivery finds it taken) and handed back when the
 * dispatch fails, so a retry can still amend. A candidate that is no longer
 * open, or whose head is no longer the one the fix was filed for (a person
 * amended it first), is left alone.
 */
import { db as defaultDb } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { githubApi as defaultGithubApi } from '@/lib/github';
import { workerOwnsPr } from '@/lib/repo-scope';
import { resolveReleaseTarget } from '@/lib/release/target';
import { recordAndDispatchRelease } from '@/lib/release/record';
import { detectArchetype } from '@buildd/core/release-archetype';
import { resolveReleaseStrategy } from '@buildd/core/release-strategy';
import { RELEASE_CANDIDATE_FIX_KEY } from '@/lib/release-candidate-ci';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { appendPrActivity } from '@/lib/pr-activity-comment';

/** Fix task context key: the fix PR whose merge already dispatched the amendment. */
export const RELEASE_CANDIDATE_AMEND_PR_KEY = 'releaseCandidateAmendPr';

export type CandidateAmendOutcome =
  | { kind: 'amended'; version: string; candidatePr: number }
  | { kind: 'skipped'; reason: 'not_a_candidate_fix' | 'wrong_base' | 'not_merged' | 'already_amended' | 'candidate_not_open' | 'candidate_moved' | 'not_configured' }
  | { kind: 'dispatch_failed'; error: string };

export interface CandidateAmendDeps {
  db?: typeof defaultDb;
  githubApi?: typeof defaultGithubApi;
  dispatch?: typeof recordAndDispatchRelease;
}

interface FixContext { prNumber: number; headSha: string; version: string; branch: string; sourceBranch: string }

/**
 * `baseRef` and `installationId` come from the webhook delivery when there is
 * one. A merge found by reconciliation (pr-reconcile, pr-state-refresh) emits
 * `pr.merged` without a delivery; then the installation is the release
 * target's and the base is read from the fix PR itself on GitHub.
 */
export async function amendCandidateOnFixMerge(
  input: { repoFullName: string; prNumber: number; baseRef?: string | null; installationId?: number | null },
  deps: CandidateAmendDeps = {},
): Promise<CandidateAmendOutcome> {
  const db = deps.db ?? defaultDb;
  const githubApi = deps.githubApi ?? defaultGithubApi;
  const dispatch = deps.dispatch ?? recordAndDispatchRelease;

  const worker = await db.query.workers.findFirst({
    where: sqlWhere(workerOwnsPr(input.repoFullName, input.prNumber)),
    columns: { taskId: true },
  });
  if (!worker?.taskId) return { kind: 'skipped', reason: 'not_a_candidate_fix' };
  const fixTask = await db.query.tasks.findFirst({
    where: sqlWhere(eq(tasks.id, worker.taskId)),
    columns: { id: true, workspaceId: true, context: true },
  });
  const fix = (fixTask?.context as Record<string, unknown> | null)?.[RELEASE_CANDIDATE_FIX_KEY] as FixContext | undefined;
  if (!fixTask || !fix?.version || !fix.sourceBranch) return { kind: 'skipped', reason: 'not_a_candidate_fix' };

  const target = await resolveReleaseTarget({ workspaceId: fixTask.workspaceId, scope: { internal: true } });
  const resolution = target.ok ? resolveReleaseStrategy(target.target.releaseConfig) : null;
  if (!target.ok || !resolution?.ok || resolution.strategy.kind !== 'workflow_dispatch') {
    return { kind: 'skipped', reason: 'not_configured' };
  }
  const t = target.target;
  const installationId = input.installationId ?? t.installationId;

  let baseRef = input.baseRef;
  if (baseRef === undefined) {
    const fixPr = await githubApi(installationId, `/repos/${input.repoFullName}/pulls/${input.prNumber}`);
    if (!fixPr?.merged) return { kind: 'skipped', reason: 'not_merged' };
    baseRef = (fixPr.base?.ref as string | undefined) ?? null;
  }
  if (baseRef !== fix.sourceBranch) return { kind: 'skipped', reason: 'wrong_base' };

  const claimed = await db
    .update(tasks)
    .set({
      context: sql`jsonb_set(coalesce(${tasks.context}, '{}'::jsonb), ${`{${RELEASE_CANDIDATE_AMEND_PR_KEY}}`}::text[], to_jsonb(${input.prNumber}::int))`,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, fixTask.id), sql`${tasks.context}->>${RELEASE_CANDIDATE_AMEND_PR_KEY} is null`))
    .returning({ id: tasks.id });
  if (claimed.length === 0) return { kind: 'skipped', reason: 'already_amended' };

  const release = async () => {
    await db
      .update(tasks)
      .set({ context: sql`${tasks.context} - ${RELEASE_CANDIDATE_AMEND_PR_KEY}`, updatedAt: new Date() })
      .where(eq(tasks.id, fixTask.id));
  };

  try {
    const candidate = await githubApi(installationId, `/repos/${input.repoFullName}/pulls/${fix.prNumber}`);
    if (candidate?.state !== 'open') return { kind: 'skipped', reason: 'candidate_not_open' };
    if (candidate?.head?.sha !== fix.headSha) return { kind: 'skipped', reason: 'candidate_moved' };

    const v = fix.version;
    const recorded = await dispatch({
      workspaceId: t.workspaceId,
      archetype: detectArchetype({ name: t.workspaceName, releaseConfig: t.releaseConfig, gitConfig: t.gitConfig }),
      installationId: t.installationId,
      owner: t.owner,
      name: t.name,
      repoFullName: t.repoFullName,
      workflowFile: resolution.strategy.workflowFile,
      ref: resolution.strategy.ref,
      prodBranch: t.releaseConfig?.prodBranch ?? t.defaultBranch,
      inputs: { ...resolution.strategy.inputs, amend: v, amend_confirm: v },
      triggeredBy: 'auto',
    });
    if (!recorded.ok) {
      await release();
      return { kind: 'dispatch_failed', error: recorded.error };
    }

    // Update the candidate PR's activity comment to show the fix PR opened and amendment was dispatched
    const releaseRunUrl = recorded.runUrl ?? null;
    const fixPrUrl = `https://github.com/${input.repoFullName}/pull/${input.prNumber}`;

    // Update the ci_fixing entry with the fix PR link now that it's ready
    await appendPrActivity({
      installationId,
      repoFullName: input.repoFullName,
      prNumber: fix.prNumber,
      updateKind: 'ci_fixing',
      entry: {
        kind: 'ci_fixing',
        detail: `fix via #${input.prNumber}, amend automatically`,
        url: fixPrUrl,
      },
      onlyIfPresent: true,
      workspaceId: t.workspaceId,
    }).catch((err: unknown) => console.error(`[release-amend] activity update (ci_fixing) on PR #${fix.prNumber} failed:`, err));

    // Add entry for fix PR opened (retroactively, since we only know about it when it merges)
    await appendPrActivity({
      installationId,
      repoFullName: input.repoFullName,
      prNumber: fix.prNumber,
      entry: {
        kind: 'fix_pr_opened',
        note: `Fix opened in #${input.prNumber} on \`${fix.sourceBranch}\`.`,
        url: fixPrUrl,
      },
      onlyIfPresent: true,
      workspaceId: t.workspaceId,
    }).catch((err: unknown) => console.error(`[release-amend] activity update (fix_pr_opened) on PR #${fix.prNumber} failed:`, err));

    // Add entry for amendment dispatched
    await appendPrActivity({
      installationId,
      repoFullName: input.repoFullName,
      prNumber: fix.prNumber,
      entry: {
        kind: 'release_amended',
        note: `The fix from #${input.prNumber} merged into \`${fix.sourceBranch}\`. Release candidate v${v} was amended automatically: the Release workflow was dispatched with \`amend: ${v}\`.`,
        url: releaseRunUrl,
      },
      onlyIfPresent: true,
      workspaceId: t.workspaceId,
    }).catch((err: unknown) => console.error(`[release-amend] activity update (release_amended) on PR #${fix.prNumber} failed:`, err));

    // Post a separate comment on the fix PR (legacy behavior, now redundant with activity update)
    await githubApi(installationId, `/repos/${input.repoFullName}/issues/${input.prNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        body: `The fix for this candidate merged in #${input.prNumber}. Amending release candidate v${v} from \`${fix.sourceBranch}\`: the Release workflow was dispatched with \`amend: ${v}\`. Its checks and approvals restart on the new head.`,
      }),
    }).catch((err: unknown) => console.error(`[release-amend] comment on fix PR #${input.prNumber} failed:`, err));
    return { kind: 'amended', version: v, candidatePr: fix.prNumber };
  } catch (err) {
    await release();
    return { kind: 'dispatch_failed', error: err instanceof Error ? err.message : String(err) };
  }
}
