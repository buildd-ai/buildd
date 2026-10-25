/**
 * When the dev-side fix for a red frozen release candidate merges, move the
 * candidate through the amend contract the workspace declared
 * (`releaseConfig.candidate.amend`) and say so on the candidate PR.
 *
 * The fix task is filed by `retryCiFailureForPr` (lib/release-candidate-ci.ts)
 * and carries `context.releaseCandidateFix`. Two signals dispatch the
 * amendment: its PR merging into the candidate's source branch, or the task
 * completing with no PR of its own while naming where the fix already is (a
 * source-branch commit pushed without a PR, or a merged PR another task owns).
 *
 * buildd dispatches only a declared contract the workflow file at `ref` still
 * takes (its `workflow_dispatch` inputs are read before every dispatch). With
 * no contract, or one the workflow no longer declares, nothing is dispatched:
 * the candidate PR, the fix task and the team are told the fix merged and the
 * candidate needs a re-cut or amend by their pipeline, with what was checked.
 *
 * Idempotent per fix PR: a compare-and-set marker on the fix task is claimed
 * before the dispatch (a redelivery finds it taken) and handed back when the
 * dispatch fails, so a retry can still amend. A re-cut notice keeps the marker:
 * it is posted once. A candidate that is no longer open, or whose head is no
 * longer the one the fix was filed for (a person amended it first), is left alone.
 */
import { db as defaultDb } from '@buildd/core/db';
import { missionNotes, tasks, workers, type ReleaseCandidateAmendContract } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { githubApi as defaultGithubApi } from '@/lib/github';
import { workerOwnsPr } from '@/lib/repo-scope';
import { resolveReleaseTarget } from '@/lib/release/target';
import { recordAndDispatchRelease } from '@/lib/release/record';
import { detectArchetype } from '@buildd/core/release-archetype';
import { resolveReleaseStrategy } from '@buildd/core/release-strategy';
import {
  RELEASE_CANDIDATE_FIX_COMMIT_KEY,
  releaseCandidateFixOf,
  verifyCandidateFixCommit,
  type CandidateFixLanded,
  type ReleaseCandidateFixContext,
} from '@/lib/candidate-fix-commit';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { appendPrActivity } from '@/lib/pr-activity-comment';
import { amendContractCapabilityError, amendDispatchInputs } from '@buildd/core/release-config-shape';
import { readWorkflowDispatchInputs as defaultReadInputs } from '@/lib/workflow-dispatch-inputs';
import { notifyTeamOf as defaultNotify } from '@/lib/notify';

/** Fix task context key: the fix PR whose merge already dispatched the amendment. */
export const RELEASE_CANDIDATE_AMEND_PR_KEY = 'releaseCandidateAmendPr';

export type CandidateAmendOutcome =
  | { kind: 'amended'; version: string; candidatePr: number }
  | { kind: 'skipped'; reason: 'not_a_candidate_fix' | 'no_fix_named' | 'wrong_base' | 'not_merged' | 'commit_not_on_source' | 'already_amended' | 'candidate_not_open' | 'candidate_moved' | 'not_configured' }
  | { kind: 'dispatch_failed'; error: string }
  /** Nothing dispatched: the team's pipeline must re-cut or amend. Posted on the candidate, the fix task and to the team. */
  | { kind: 'needs_recut'; reason: 'no_contract' | 'contract_not_in_workflow' | 'workflow_unreadable'; checked: string; candidatePr: number };

export interface CandidateAmendDeps {
  db?: typeof defaultDb;
  githubApi?: typeof defaultGithubApi;
  dispatch?: typeof recordAndDispatchRelease;
  readInputs?: typeof defaultReadInputs;
  notify?: typeof defaultNotify;
}

type FixContext = ReleaseCandidateFixContext;

/** What carried the fix onto the candidate's source branch. */
export type FixVia = { kind: 'pr'; prNumber: number } | { kind: 'commit'; sha: string };

/** "merged in #101" / "landed on `dev` in `b9c6a996b000`": how the candidate PR is told. */
function fixedIn(via: FixVia, sourceBranch: string): string {
  return via.kind === 'pr' ? `merged in #${via.prNumber}` : `landed on \`${sourceBranch}\` in \`${via.sha.slice(0, 12)}\``;
}

type FixTaskRow = { id: string; workspaceId: string; missionId: string | null; context: unknown };

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
  const worker = await db.query.workers.findFirst({
    where: sqlWhere(workerOwnsPr(input.repoFullName, input.prNumber)),
    columns: { taskId: true },
  });
  if (!worker?.taskId) return { kind: 'skipped', reason: 'not_a_candidate_fix' };
  const fixTask = await db.query.tasks.findFirst({
    where: sqlWhere(eq(tasks.id, worker.taskId)),
    columns: { id: true, workspaceId: true, missionId: true, context: true },
  });
  if (!fixTask) return { kind: 'skipped', reason: 'not_a_candidate_fix' };
  return amendForFixTask(fixTask, { kind: 'pr', prNumber: input.prNumber }, input, deps);
}

/**
 * A candidate fix task completed without a PR of its own, naming where the fix
 * already is: a dev commit (`candidateFixLanded`, checked by
 * lib/candidate-fix-commit.ts before the completion was accepted) or a
 * merged PR another task owns (`alreadyShippedIn`). Neither ever emits a
 * `pr.merged` this task owns, so without this the candidate stays red until an
 * operator amends it by hand.
 */
export async function amendCandidateOnFixCompletion(
  input: { taskId: string },
  deps: CandidateAmendDeps = {},
): Promise<CandidateAmendOutcome> {
  const db = deps.db ?? defaultDb;
  const fixTask = await db.query.tasks.findFirst({
    where: sqlWhere(eq(tasks.id, input.taskId)),
    columns: { id: true, workspaceId: true, missionId: true, context: true, result: true },
  });
  if (!fixTask || !releaseCandidateFixOf(fixTask.context)) return { kind: 'skipped', reason: 'not_a_candidate_fix' };
  const result = (fixTask.result ?? {}) as Record<string, unknown>;
  const landed = result[RELEASE_CANDIDATE_FIX_COMMIT_KEY] as CandidateFixLanded | undefined;
  const shipped = result.alreadyShippedIn as { prNumber?: number } | undefined;
  const via: FixVia | null = landed?.commitSha
    ? { kind: 'commit', sha: landed.commitSha }
    : typeof shipped?.prNumber === 'number' ? { kind: 'pr', prNumber: shipped.prNumber } : null;
  if (!via) return { kind: 'skipped', reason: 'no_fix_named' };
  return amendForFixTask(fixTask, via, {}, deps);
}

async function amendForFixTask(
  fixTask: FixTaskRow,
  via: FixVia,
  input: { repoFullName?: string; baseRef?: string | null; installationId?: number | null },
  deps: CandidateAmendDeps,
): Promise<CandidateAmendOutcome> {
  const db = deps.db ?? defaultDb;
  const githubApi = deps.githubApi ?? defaultGithubApi;
  const dispatch = deps.dispatch ?? recordAndDispatchRelease;
  const readInputs = deps.readInputs ?? defaultReadInputs;
  const notify = deps.notify ?? defaultNotify;

  const fix = releaseCandidateFixOf(fixTask.context);
  if (!fix) return { kind: 'skipped', reason: 'not_a_candidate_fix' };

  const target = await resolveReleaseTarget({ workspaceId: fixTask.workspaceId, scope: { internal: true } });
  if (!target.ok) return { kind: 'skipped', reason: 'not_configured' };
  const t = target.target;
  const resolution = resolveReleaseStrategy(t.releaseConfig);
  const strategy = resolution.ok && resolution.strategy.kind === 'workflow_dispatch' ? resolution.strategy : null;
  const contract = t.releaseConfig?.candidate?.amend;
  const installationId = input.installationId ?? t.installationId;
  const repoFullName = input.repoFullName ?? t.repoFullName;

  if (via.kind === 'pr') {
    let baseRef = input.baseRef;
    if (baseRef === undefined) {
      const fixPr = await githubApi(installationId, `/repos/${repoFullName}/pulls/${via.prNumber}`);
      if (!fixPr?.merged) return { kind: 'skipped', reason: 'not_merged' };
      baseRef = (fixPr.base?.ref as string | undefined) ?? null;
    }
    if (baseRef !== fix.sourceBranch) return { kind: 'skipped', reason: 'wrong_base' };
  } else {
    // Checked when the completion was accepted; checked again here, because a
    // redelivery or a replay can come long after and the branch may have moved.
    const check = await verifyCandidateFixCommit({ api: githubApi, installationId, repoFullName, sha: via.sha, fix });
    if (!check.ok) return { kind: 'skipped', reason: 'commit_not_on_source' };
  }

  const marker = via.kind === 'pr' ? sql`to_jsonb(${via.prNumber}::int)` : sql`to_jsonb(${via.sha}::text)`;
  const claimed = await db
    .update(tasks)
    .set({
      context: sql`jsonb_set(coalesce(${tasks.context}, '{}'::jsonb), ${`{${RELEASE_CANDIDATE_AMEND_PR_KEY}}`}::text[], ${marker})`,
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
    const candidate = await githubApi(installationId, `/repos/${repoFullName}/pulls/${fix.prNumber}`);
    if (candidate?.state !== 'open') return { kind: 'skipped', reason: 'candidate_not_open' };
    if (candidate?.head?.sha !== fix.headSha) return { kind: 'skipped', reason: 'candidate_moved' };

    const v = fix.version;
    const recut = (reason: Extract<CandidateAmendOutcome, { kind: 'needs_recut' }>['reason'], checked: string) =>
      postRecutNotice({ db, githubApi, notify, installationId, repoFullName, via, fix, fixTask, reason, checked });

    if (!contract || !strategy) {
      return recut('no_contract', !strategy
        ? 'the release strategy is not workflow_dispatch, so buildd has no workflow to dispatch'
        : 'the workspace release settings declare no amend contract (release candidates → "When a fix merges")');
    }
    const where = `\`${strategy.workflowFile}\` at \`${strategy.ref}\``;
    const declared = await readInputs({ installationId, repoFullName, workflowFile: strategy.workflowFile, ref: strategy.ref }, githubApi);
    if (!declared.ok) return recut('workflow_unreadable', declared.error);
    const capability = amendContractCapabilityError(contract, declared.inputs, where);
    if (capability) return recut('contract_not_in_workflow', capability);

    const recorded = await dispatch({
      workspaceId: t.workspaceId,
      archetype: detectArchetype({ name: t.workspaceName, releaseConfig: t.releaseConfig, gitConfig: t.gitConfig }),
      installationId: t.installationId,
      owner: t.owner,
      name: t.name,
      repoFullName: t.repoFullName,
      workflowFile: strategy.workflowFile,
      ref: strategy.ref,
      prodBranch: t.releaseConfig?.prodBranch ?? t.defaultBranch,
      inputs: amendDispatchInputs(contract, v, strategy.inputs),
      triggeredBy: 'auto',
      amendment: true,
    });
    if (!recorded.ok) {
      await release();
      return { kind: 'dispatch_failed', error: recorded.error };
    }

    // The candidate's activity comment follows the fix: pointed at the fix, then opened, then amended.
    const releaseRunUrl = recorded.runUrl ?? null;
    const fixRef = via.kind === 'pr' ? `#${via.prNumber}` : `\`${via.sha.slice(0, 12)}\``;
    const fixUrl = via.kind === 'pr'
      ? `https://github.com/${repoFullName}/pull/${via.prNumber}`
      : `https://github.com/${repoFullName}/commit/${via.sha}`;
    const track = (kind: string, entry: Parameters<typeof appendPrActivity>[0]['entry'], updateKind?: 'ci_fixing') =>
      appendPrActivity({
        installationId,
        repoFullName,
        prNumber: fix.prNumber,
        ...(updateKind ? { updateKind } : {}),
        entry,
        onlyIfPresent: true,
        workspaceId: t.workspaceId,
      }).catch((err: unknown) => console.error(`[release-amend] activity update (${kind}) on PR #${fix.prNumber} failed:`, err));

    await track('ci_fixing', { kind: 'ci_fixing', detail: `fix via ${fixRef}, amend automatically`, url: fixUrl }, 'ci_fixing');
    if (via.kind === 'pr') {
      // Only known once it merges, so the row is written retroactively.
      await track('fix_pr_opened', { kind: 'fix_pr_opened', note: `Fix opened in ${fixRef} on \`${fix.sourceBranch}\`.`, url: fixUrl });
    }
    await track('release_amended', {
      kind: 'release_amended',
      note: `The fix ${fixedIn(via, fix.sourceBranch)}. Release candidate v${v} was amended automatically: the Release workflow was dispatched with \`amend: ${v}\`.`,
      url: releaseRunUrl,
    });

    // The standing comment on the candidate PR.
    await githubApi(installationId, `/repos/${repoFullName}/issues/${fix.prNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: amendedComment(contract, v, via, fix.sourceBranch, strategy.workflowFile) }),
    }).catch((err: unknown) => console.error(`[release-amend] comment on candidate PR #${fix.prNumber} failed:`, err));
    return { kind: 'amended', version: v, candidatePr: fix.prNumber };
  } catch (err) {
    await release();
    return { kind: 'dispatch_failed', error: err instanceof Error ? err.message : String(err) };
  }
}

function amendedComment(contract: ReleaseCandidateAmendContract, v: string, via: FixVia, sourceBranch: string, workflowFile: string): string {
  const how = contract.mode === 'inputs'
    ? `\`${workflowFile}\` was dispatched with \`${contract.versionInput}: ${v}\``
    : `\`${workflowFile}\` was dispatched again for your pipeline to re-cut it`;
  return `The fix for this candidate ${fixedIn(via, sourceBranch)}. Amending release candidate v${v} from \`${sourceBranch}\`: ${how}. Its checks and approvals restart on the new head.`;
}

/**
 * Nothing was dispatched: say so where a person will see it. A comment on the
 * candidate PR, an open note on the fix task, and a needs-attention alert to
 * the team, each naming what was checked. Best-effort: one failing surface
 * does not stop the others.
 */
async function postRecutNotice(p: {
  db: typeof defaultDb;
  githubApi: typeof defaultGithubApi;
  notify: typeof defaultNotify;
  installationId: number;
  repoFullName: string;
  via: FixVia;
  fix: FixContext;
  fixTask: { id: string; missionId: string | null };
  reason: Extract<CandidateAmendOutcome, { kind: 'needs_recut' }>['reason'];
  checked: string;
}): Promise<CandidateAmendOutcome> {
  const v = `v${p.fix.version}`;
  const how = fixedIn(p.via, p.fix.sourceBranch);
  const body = `The fix for this candidate ${how}, but buildd did not amend release candidate ${v}. ` +
    `It still holds the commit that failed CI: your release pipeline needs to re-cut or amend it from \`${p.fix.sourceBranch}\`.\n\n` +
    `Checked: ${p.checked}.`;
  const log = (what: string) => (err: unknown) => console.error(`[release-amend] re-cut notice (${what}) for PR #${p.fix.prNumber} failed:`, err);

  await p.githubApi(p.installationId, `/repos/${p.repoFullName}/issues/${p.fix.prNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  }).catch(log('comment'));
  await p.db.insert(missionNotes).values({
    missionId: p.fixTask.missionId,
    taskId: p.fixTask.id,
    authorType: 'system',
    type: 'warning',
    title: `Release candidate ${v} needs a re-cut: the fix landed, buildd did not amend it`,
    body,
    actorLabel: `candidate amend: ${p.reason}`,
    status: 'open',
  }).catch(log('task note'));
  await p.notify({ taskId: p.fixTask.id }, 'needsAttention', {
    title: `Release candidate ${v} needs a re-cut`,
    message: `The fix ${how}. buildd did not amend the candidate (PR #${p.fix.prNumber}): ${p.checked}.`,
    url: `https://github.com/${p.repoFullName}/pull/${p.fix.prNumber}`,
    urlTitle: `Release candidate ${v}`,
    priority: 0,
  }).catch(log('alert'));
  return { kind: 'needs_recut', reason: p.reason, checked: p.checked, candidatePr: p.fix.prNumber };
}
