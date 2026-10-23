/**
 * When the dev-side fix for a red frozen release candidate merges, move the
 * candidate through the amend contract the workspace declared
 * (`releaseConfig.candidate.amend`) and say so on the candidate PR.
 *
 * The fix task is filed by `retryCiFailureForPr` (lib/release-candidate-ci.ts)
 * and carries `context.releaseCandidateFix`. Its PR merging into the candidate's
 * source branch is the signal; nothing else dispatches the amendment.
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
import { RELEASE_CANDIDATE_FIX_KEY } from '@/lib/release-candidate-ci';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { amendContractCapabilityError, amendDispatchInputs } from '@buildd/core/release-config-shape';
import { readWorkflowDispatchInputs as defaultReadInputs } from '@/lib/workflow-dispatch-inputs';
import { notifyTeamOf as defaultNotify } from '@/lib/notify';

/** Fix task context key: the fix PR whose merge already dispatched the amendment. */
export const RELEASE_CANDIDATE_AMEND_PR_KEY = 'releaseCandidateAmendPr';

export type CandidateAmendOutcome =
  | { kind: 'amended'; version: string; candidatePr: number }
  | { kind: 'skipped'; reason: 'not_a_candidate_fix' | 'wrong_base' | 'not_merged' | 'already_amended' | 'candidate_not_open' | 'candidate_moved' | 'not_configured' }
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
  const readInputs = deps.readInputs ?? defaultReadInputs;
  const notify = deps.notify ?? defaultNotify;

  const worker = await db.query.workers.findFirst({
    where: sqlWhere(workerOwnsPr(input.repoFullName, input.prNumber)),
    columns: { taskId: true },
  });
  if (!worker?.taskId) return { kind: 'skipped', reason: 'not_a_candidate_fix' };
  const fixTask = await db.query.tasks.findFirst({
    where: sqlWhere(eq(tasks.id, worker.taskId)),
    columns: { id: true, workspaceId: true, missionId: true, context: true },
  });
  const fix = (fixTask?.context as Record<string, unknown> | null)?.[RELEASE_CANDIDATE_FIX_KEY] as FixContext | undefined;
  if (!fixTask || !fix?.version || !fix.sourceBranch) return { kind: 'skipped', reason: 'not_a_candidate_fix' };

  const target = await resolveReleaseTarget({ workspaceId: fixTask.workspaceId, scope: { internal: true } });
  if (!target.ok) return { kind: 'skipped', reason: 'not_configured' };
  const t = target.target;
  const resolution = resolveReleaseStrategy(t.releaseConfig);
  const strategy = resolution.ok && resolution.strategy.kind === 'workflow_dispatch' ? resolution.strategy : null;
  const contract = t.releaseConfig?.candidate?.amend;
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
    const recut = (reason: Extract<CandidateAmendOutcome, { kind: 'needs_recut' }>['reason'], checked: string) =>
      postRecutNotice({ db, githubApi, notify, installationId, repoFullName: input.repoFullName, fixPrNumber: input.prNumber, fix, fixTask, reason, checked });

    if (!contract || !strategy) {
      return recut('no_contract', !strategy
        ? 'the release strategy is not workflow_dispatch, so buildd has no workflow to dispatch'
        : 'the workspace release settings declare no amend contract (release candidates → "When a fix merges")');
    }
    const where = `\`${strategy.workflowFile}\` at \`${strategy.ref}\``;
    const declared = await readInputs({ installationId, repoFullName: input.repoFullName, workflowFile: strategy.workflowFile, ref: strategy.ref }, githubApi);
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

    await githubApi(installationId, `/repos/${input.repoFullName}/issues/${fix.prNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: amendedComment(contract, v, input.prNumber, fix.sourceBranch, strategy.workflowFile) }),
    }).catch((err: unknown) => console.error(`[release-amend] comment on PR #${fix.prNumber} failed:`, err));
    return { kind: 'amended', version: v, candidatePr: fix.prNumber };
  } catch (err) {
    await release();
    return { kind: 'dispatch_failed', error: err instanceof Error ? err.message : String(err) };
  }
}

function amendedComment(contract: ReleaseCandidateAmendContract, v: string, fixPr: number, sourceBranch: string, workflowFile: string): string {
  const how = contract.mode === 'inputs'
    ? `\`${workflowFile}\` was dispatched with \`${contract.versionInput}: ${v}\``
    : `\`${workflowFile}\` was dispatched again for your pipeline to re-cut it`;
  return `The fix for this candidate merged in #${fixPr}. Amending release candidate v${v} from \`${sourceBranch}\`: ${how}. Its checks and approvals restart on the new head.`;
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
  fixPrNumber: number;
  fix: FixContext;
  fixTask: { id: string; missionId: string | null };
  reason: Extract<CandidateAmendOutcome, { kind: 'needs_recut' }>['reason'];
  checked: string;
}): Promise<CandidateAmendOutcome> {
  const v = `v${p.fix.version}`;
  const body = `The fix for this candidate merged in #${p.fixPrNumber}, but buildd did not amend release candidate ${v}. ` +
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
    title: `Release candidate ${v} needs a re-cut: the fix merged, buildd did not amend it`,
    body,
    actorLabel: `candidate amend: ${p.reason}`,
    status: 'open',
  }).catch(log('task note'));
  await p.notify({ taskId: p.fixTask.id }, 'needsAttention', {
    title: `Release candidate ${v} needs a re-cut`,
    message: `The fix merged in #${p.fixPrNumber}. buildd did not amend the candidate (PR #${p.fix.prNumber}): ${p.checked}.`,
    url: `https://github.com/${p.repoFullName}/pull/${p.fix.prNumber}`,
    urlTitle: `Release candidate ${v}`,
    priority: 0,
  }).catch(log('alert'));
  return { kind: 'needs_recut', reason: p.reason, checked: p.checked, candidatePr: p.fix.prNumber };
}
