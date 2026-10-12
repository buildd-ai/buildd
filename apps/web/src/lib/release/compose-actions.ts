/**
 * The buttons of the owner's release flow. Each one re-reads the flow from
 * GitHub (never trusts SHAs or PR numbers from the page), refuses when the
 * page it was pressed on is stale, acts through the one path that already
 * owns that action, and records who pressed it and what happened.
 *
 *   include  — merge a ready mission PR into the source branch through the
 *              dashboard's gated merge (POST /api/prs/[n]/merge). Never a raw merge.
 *   cut      — dispatch the Release workflow on the source branch; changes the
 *              owner left out ride along as `exclude` (reverted on the candidate).
 *   exclude  — leave more changes out of the open candidate: an explicit
 *              amendment, new candidate SHA, checks and approvals void.
 *   release  — merge the candidate into the production branch, pinned to the
 *              candidate SHA, only when every required check passed and an
 *              approval stands on that exact SHA. Branch protection still applies.
 *   confirm  — mark it released, only when production reports running the
 *              candidate's merge commit (or a descendant).
 */

import { db as defaultDb } from '@buildd/core/db';
import { releaseFlowSteps, type NewReleaseFlowStep } from '@buildd/core/db/schema';
import { exclusionNotice, missionKey, planComposition, type ComposeKey } from '@buildd/core/release-compose';
import { detectArchetype } from '@buildd/core/release-archetype';
import { resolveReleaseStrategy } from '@buildd/core/release-strategy';
import type { MergePullRequestResult } from '@/lib/github';
import type { RecordAndDispatchParams, RecordAndDispatchResult } from './record';
import type { DispatchResult } from './dispatch';
import type { LoadFlowResult, ReleaseFlowView } from './compose-source';
import type { ReleaseTarget } from './target';

export type ComposeAction =
  | { action: 'include'; missionId: string }
  | { action: 'cut'; selected: string[]; expectedSourceSha: string; confirmed?: boolean }
  | { action: 'exclude'; keys: string[]; expectedCandidateSha: string; confirmed?: boolean }
  | { action: 'release'; expectedCandidateSha: string }
  | { action: 'confirm' };

const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null);

/** The body's action, shape-checked; null when it is not one of the five. */
export function parseComposeAction(body: any): ComposeAction | null {
  switch (body?.action) {
    case 'include':
      return typeof body.missionId === 'string' ? { action: 'include', missionId: body.missionId } : null;
    case 'cut': {
      const selected = strings(body.selected);
      return selected && typeof body.expectedSourceSha === 'string'
        ? { action: 'cut', selected, expectedSourceSha: body.expectedSourceSha, confirmed: body.confirmed === true }
        : null;
    }
    case 'exclude': {
      const keys = strings(body.keys);
      return keys && typeof body.expectedCandidateSha === 'string'
        ? { action: 'exclude', keys, expectedCandidateSha: body.expectedCandidateSha, confirmed: body.confirmed === true }
        : null;
    }
    case 'release':
      return typeof body.expectedCandidateSha === 'string' ? { action: 'release', expectedCandidateSha: body.expectedCandidateSha } : null;
    case 'confirm':
      return { action: 'confirm' };
    default:
      return null;
  }
}

export interface ComposeActionResult {
  ok: boolean;
  status: number;
  /** One plain sentence for the page: what happened, or why nothing did. */
  message: string;
  /** Set when the owner must read this and confirm before anything happens. */
  needsConfirmation?: string;
  runUrl?: string | null;
}

export interface ComposeActionDeps {
  db?: typeof defaultDb;
  loadFlow: () => Promise<LoadFlowResult>;
  /** The dashboard's gated merge for a worker-owned PR; returns its HTTP status and body. */
  mergeThroughGate: (prNumber: number, workspaceId: string) => Promise<{ status: number; body: any }>;
  recordAndDispatch: (params: RecordAndDispatchParams) => Promise<RecordAndDispatchResult>;
  dispatch: (installationId: number, owner: string, name: string, opts: { workflowFile: string; ref: string; inputs: Record<string, string> }) => Promise<DispatchResult>;
  mergePr: (installationId: number, repo: string, prNumber: number, method: 'merge', expectedHeadSha: string) => Promise<MergePullRequestResult>;
  /** Live head of a branch, to refuse a cut when dev moved under the page. */
  branchHead: (branch: string) => Promise<string | null>;
}

const result = (status: number, message: string, extra: Partial<ComposeActionResult> = {}): ComposeActionResult => ({
  ok: status < 300,
  status,
  message,
  ...extra,
});

async function record(deps: ComposeActionDeps, row: NewReleaseFlowStep): Promise<void> {
  const db = deps.db ?? defaultDb;
  await db.insert(releaseFlowSteps).values(row);
}

/** The release workflow this workspace dispatches, or why it cannot. */
function workflowOf(target: ReleaseTarget): { ok: true; workflowFile: string; ref: string } | { ok: false; error: string } {
  const res = resolveReleaseStrategy(target.releaseConfig);
  if (!res.ok) return { ok: false, error: res.message };
  if (res.strategy.kind !== 'workflow_dispatch') return { ok: false, error: 'Frozen candidates are cut by a release workflow; this workspace does not dispatch one.' };
  return { ok: true, workflowFile: res.strategy.workflowFile, ref: res.strategy.ref };
}

export async function runComposeAction(
  target: ReleaseTarget,
  actorUserId: string,
  input: ComposeAction,
  deps: ComposeActionDeps,
): Promise<ComposeActionResult> {
  const loaded = await deps.loadFlow();
  if (!loaded.ok) return result(loaded.status, loaded.error);
  const view = loaded.view;
  const base: Pick<NewReleaseFlowStep, 'workspaceId' | 'actorUserId'> = { workspaceId: target.workspaceId, actorUserId };

  switch (input.action) {
    case 'include':
      return include(target, view, input.missionId, base, deps);
    case 'cut':
      return cut(target, view, input, base, deps);
    case 'exclude':
      return exclude(target, view, input, base, deps);
    case 'release':
      return release(target, view, input.expectedCandidateSha, base, deps);
    case 'confirm':
      return confirm(view, base, deps);
  }
}

async function include(
  target: ReleaseTarget,
  view: ReleaseFlowView,
  missionId: string,
  base: Pick<NewReleaseFlowStep, 'workspaceId' | 'actorUserId'>,
  deps: ComposeActionDeps,
): Promise<ComposeActionResult> {
  if (view.candidate) return result(409, `v${view.candidate.version} is already cut; a mission merged now ships in the next release.`);
  const group = view.composition.ready.find((g) => g.key === missionKey(missionId));
  if (!group) {
    const notReady = view.composition.notReady.find((g) => g.key === missionKey(missionId));
    return result(409, notReady ? `${notReady.mission.title} is not ready: its mission PR needs an approval and passing checks.` : 'That mission has no ready mission PR. Reload the page.');
  }
  const prNumber = group.prs[0].number;
  const merged = await deps.mergeThroughGate(prNumber, target.workspaceId);
  const ok = merged.status >= 200 && merged.status < 300 && merged.body?.merged !== false;
  const pending = merged.status === 202;
  const refusal = String(merged.body?.error ?? merged.body?.message ?? '');
  await record(deps, {
    ...base,
    step: 'include',
    outcome: ok ? 'succeeded' : pending ? 'pending' : 'refused',
    prNumber,
    missionId,
    detail: { title: group.mission.title, httpStatus: merged.status, ...(ok ? {} : { reason: refusal.slice(0, 500) }) },
  });
  if (ok) return result(200, `Merged ${group.mission.title} (#${prNumber}) into ${view.sourceBranch}.`);
  if (pending) return result(202, refusal || `#${prNumber} is updating; it merges when its checks pass on the new head.`);
  return result(merged.status >= 400 ? merged.status : 409, refusal || `#${prNumber} was not merged.`);
}

async function cut(
  target: ReleaseTarget,
  view: ReleaseFlowView,
  input: Extract<ComposeAction, { action: 'cut' }>,
  base: Pick<NewReleaseFlowStep, 'workspaceId' | 'actorUserId'>,
  deps: ComposeActionDeps,
): Promise<ComposeActionResult> {
  if (view.candidate) return result(409, `v${view.candidate.version} is already cut. Review it, or leave changes out of it.`);
  if (view.merged && !view.merged.confirmed) {
    return result(409, `v${view.merged.version} is merged but production has not been confirmed yet. Confirm it before cutting the next one.`);
  }
  if (!view.compositionSha || input.expectedSourceSha !== view.compositionSha) {
    return result(409, `${view.sourceBranch} moved since this page loaded. Reload to see what would ship now.`);
  }
  const plan = planComposition(view.composition, input.selected);
  if (plan.unknown.length) return result(409, 'The selection names changes that are not on this page any more. Reload.');
  if (plan.merges.length) return result(409, `Include ${plan.merges.map((m) => m.title).join(', ')} first: a ready mission is merged into ${view.sourceBranch} before the cut.`);
  if (plan.unrevertable.length) return result(422, 'A change you left out has no merge commit to revert. Keep it in, or leave it out after the cut.');
  if (plan.missionCount + plan.otherCount === 0) return result(422, 'Nothing is selected. A release needs at least one change.');
  const notice = exclusionNotice(plan.exclusions, null);
  if (notice && !input.confirmed) return result(409, notice, { needsConfirmation: notice });

  const wf = workflowOf(target);
  if (!wf.ok) return result(422, wf.error);
  // dev must not have moved between the page and the dispatch: the workflow
  // captures whatever dev is when it starts.
  const live = await deps.branchHead(view.sourceBranch);
  if (live !== view.compositionSha) return result(409, `${view.sourceBranch} moved since this page loaded. Reload to see what would ship now.`);

  const shas = plan.exclusions.flatMap((e) => e.shas);
  const inputs: Record<string, string> = shas.length ? { exclude: shas.join(' '), exclude_confirm: 'revert' } : {};
  const archetype = detectArchetype({ name: target.workspaceName, releaseConfig: target.releaseConfig, gitConfig: target.gitConfig });
  const dispatched = await deps.recordAndDispatch({
    workspaceId: target.workspaceId,
    archetype: archetype === 'none' ? 'gated' : archetype,
    installationId: target.installationId,
    owner: target.owner,
    name: target.name,
    repoFullName: target.repoFullName,
    workflowFile: wf.workflowFile,
    ref: wf.ref,
    prodBranch: view.prodBranch,
    inputs,
    triggeredBy: 'user',
  });
  await record(deps, {
    ...base,
    step: 'cut',
    outcome: dispatched.ok ? 'pending' : 'failed',
    detail: {
      sourceSha: view.compositionSha,
      missions: plan.missionCount,
      other: plan.otherCount,
      leftOut: plan.exclusions.map((e) => ({ key: e.key, label: e.label, shas: e.shas })),
      ...(dispatched.ok ? { runUrl: dispatched.runUrl ?? dispatched.runsUrl ?? null, releaseId: dispatched.releaseId } : { error: dispatched.error }),
    },
  });
  if (!dispatched.ok) return result(dispatched.status, dispatched.error);
  return result(202, `Cutting the candidate from ${view.sourceBranch} at ${view.compositionSha.slice(0, 9)}. It appears here when the release workflow opens it.`, {
    runUrl: dispatched.runUrl ?? dispatched.runsUrl ?? null,
  });
}

async function exclude(
  target: ReleaseTarget,
  view: ReleaseFlowView,
  input: Extract<ComposeAction, { action: 'exclude' }>,
  base: Pick<NewReleaseFlowStep, 'workspaceId' | 'actorUserId'>,
  deps: ComposeActionDeps,
): Promise<ComposeActionResult> {
  const c = view.candidate;
  if (!c) return result(409, 'There is no open candidate to leave changes out of.');
  if (input.expectedCandidateSha !== c.candidateSha) return result(409, `The candidate changed since this page loaded (now ${c.candidateSha.slice(0, 9)}). Reload.`);
  const keys = input.keys.filter((k) => !view.leftOut.includes(k));
  if (keys.length === 0) return result(422, 'Pick at least one change that is still in the candidate.');
  const stillIn = view.defaultSelected.filter((k) => !keys.includes(k));
  const plan = planComposition(view.composition, stillIn);
  const fresh = plan.exclusions.filter((e) => keys.includes(e.key));
  if (fresh.length !== keys.length) return result(409, 'The selection names changes that are not in this candidate. Reload.');
  if (plan.unrevertable.some((k) => keys.includes(k as ComposeKey))) return result(422, 'A change you picked has no merge commit to revert.');
  const notice = exclusionNotice(fresh, c.candidateSha)!;
  if (!input.confirmed) return result(409, notice, { needsConfirmation: notice });

  const wf = workflowOf(target);
  if (!wf.ok) return result(422, wf.error);
  const shas = fresh.flatMap((e) => e.shas);
  let runUrl: string | null = null;
  try {
    const d = await deps.dispatch(target.installationId, target.owner, target.name, {
      workflowFile: wf.workflowFile,
      ref: wf.ref,
      inputs: { exclude: shas.join(' '), exclude_confirm: 'revert' },
    });
    runUrl = d.runUrl ?? d.runsUrl ?? null;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await record(deps, { ...base, step: 'exclude', outcome: 'failed', version: c.version, candidateSha: c.candidateSha, prNumber: c.prNumber, detail: { shas, error } });
    return result(502, `The release workflow could not be started: ${error}`);
  }
  await record(deps, {
    ...base,
    step: 'exclude',
    outcome: 'pending',
    version: c.version,
    candidateSha: c.candidateSha,
    prNumber: c.prNumber,
    detail: { leftOut: fresh.map((e) => ({ key: e.key, label: e.label, shas: e.shas })), runUrl },
  });
  return result(202, `Leaving ${fresh.map((e) => e.label).join(', ')} out of v${c.version}. The candidate gets a new SHA; checks and review start again on it.`, { runUrl });
}

async function release(
  target: ReleaseTarget,
  view: ReleaseFlowView,
  expectedCandidateSha: string,
  base: Pick<NewReleaseFlowStep, 'workspaceId' | 'actorUserId'>,
  deps: ComposeActionDeps,
): Promise<ComposeActionResult> {
  const c = view.candidate;
  if (!c) return result(409, 'There is no open candidate to release.');
  if (expectedCandidateSha !== c.candidateSha) return result(409, `The candidate changed since this page loaded (now ${c.candidateSha.slice(0, 9)}). Review it again.`);
  const refuse = async (message: string) => {
    await record(deps, { ...base, step: 'release', outcome: 'refused', version: c.version, candidateSha: c.candidateSha, prNumber: c.prNumber, detail: { reason: message } });
    return result(409, message);
  };
  const bad = c.verdict.checks.filter((x) => x.state !== 'passing').map((x) => x.name);
  if (bad.length) return refuse(`Not released: ${bad.join(', ')} ${bad.length === 1 ? 'has' : 'have'} not passed on ${c.candidateSha.slice(0, 9)}.`);
  if (!c.verdict.approved) return refuse(`Not released: no approval stands on ${c.candidateSha.slice(0, 9)}.`);

  const merged = await deps.mergePr(target.installationId, target.repoFullName, c.prNumber, 'merge', c.candidateSha);
  await record(deps, {
    ...base,
    step: 'release',
    outcome: merged.merged ? 'succeeded' : merged.indeterminate ? 'pending' : 'refused',
    version: c.version,
    candidateSha: c.candidateSha,
    prNumber: c.prNumber,
    detail: { missions: view.counts.missions, other: view.counts.other, message: merged.message.slice(0, 500) },
  });
  if (merged.merged) {
    return result(200, `Merged v${c.version} into ${view.prodBranch}. It is released when production runs it.`);
  }
  if (merged.indeterminate) return result(202, `GitHub did not answer clearly (${merged.message}). Reload in a minute to see whether v${c.version} merged.`);
  return result(409, `GitHub refused the merge: ${merged.message}`);
}

async function confirm(
  view: ReleaseFlowView,
  base: Pick<NewReleaseFlowStep, 'workspaceId' | 'actorUserId'>,
  deps: ComposeActionDeps,
): Promise<ComposeActionResult> {
  const m = view.merged;
  if (!m) return result(409, 'No merged candidate is waiting for production.');
  if (m.confirmed) return result(200, `v${m.version} is already confirmed in production.`);
  const row = { ...base, step: 'confirm_production' as const, version: m.version, candidateSha: m.mergeSha, prNumber: m.prNumber };
  if (m.production !== 'released') {
    const msg = m.deployedSha
      ? `Production runs ${m.deployedSha.slice(0, 9)}, which does not contain v${m.version} (${m.mergeSha.slice(0, 9)}) yet. Not marked released.`
      : `Production did not report a deployed SHA, so v${m.version} cannot be confirmed. Not marked released.`;
    await record(deps, { ...row, outcome: 'refused', detail: { mergeSha: m.mergeSha, deployedSha: m.deployedSha } });
    return result(409, msg);
  }
  await record(deps, { ...row, outcome: 'succeeded', detail: { mergeSha: m.mergeSha, deployedSha: m.deployedSha } });
  return result(200, `v${m.version} is released: production runs ${m.deployedSha!.slice(0, 9)}.`);
}
