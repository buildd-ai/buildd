import { describe, expect, it, mock } from 'bun:test';
import { candidateVerdict, defaultSelection, groupComposition, missionKey, prKey, REQUIRED_CANDIDATE_CHECKS } from '@buildd/core/release-compose';
import { parseComposeAction, runComposeAction, type ComposeActionDeps } from './compose-actions';
import type { CandidateState, MergedCandidateState, ReleaseFlowView } from './compose-source';
import type { ReleaseTarget } from './target';

const DEV = 'd'.repeat(40);
const CAND = 'c'.repeat(40);
const OLD = 'o'.repeat(40);
const MERGE = 'm'.repeat(40);

const target: ReleaseTarget = {
  workspaceId: 'ws-1',
  workspaceName: 'app',
  owner: 'o',
  name: 'r',
  repoFullName: 'o/r',
  installationId: 1,
  defaultBranch: 'main',
  gitConfig: null,
  releaseConfig: {
    enabled: true,
    strategy: 'workflow_dispatch',
    workflowFile: 'release.yml',
    ref: 'dev',
    prodBranch: 'main',
    candidate: { branches: ['release/v*'], sourceBranch: 'dev', authors: ['release-bot[bot]'] },
  },
};

const composition = () =>
  groupComposition({
    shippedPrs: [
      { number: 10, title: 'Billing', url: 'u10', mergeSha: 'a'.repeat(40), missionId: 'm1' },
      { number: 11, title: 'Typo', url: 'u11', mergeSha: 'b'.repeat(40), missionId: null },
    ],
    missions: [
      { id: 'm1', title: 'Billing', criteria: null, missionPr: null },
      { id: 'm3', title: 'Search', criteria: { met: 1, total: 1 }, missionPr: { number: 30, title: 'Ship Search', url: 'u30', state: 'open', approved: true, checks: 'passing' } },
      { id: 'm4', title: 'Draft', criteria: null, missionPr: { number: 40, title: 'Ship Draft', url: 'u40', state: 'open', approved: false, checks: 'passing' } },
    ],
  });

function candidate(over: Partial<CandidateState> = {}): CandidateState {
  return {
    prNumber: 99,
    url: 'u99',
    version: '1.4.0',
    candidateSha: CAND,
    sourceSha: DEV,
    amendment: 0,
    previousCandidateSha: null,
    reverted: [],
    verdict: candidateVerdict({
      candidateSha: CAND,
      required: REQUIRED_CANDIDATE_CHECKS,
      checks: REQUIRED_CANDIDATE_CHECKS.map((name) => ({ name, sha: CAND, state: 'passing' as const, url: null })),
      reviews: [{ author: 'owner', state: 'APPROVED', sha: CAND }],
    }),
    refusal: null,
    deltaUrl: null,
    ...over,
  };
}

function view(over: Partial<ReleaseFlowView> = {}): ReleaseFlowView {
  const c = composition();
  return {
    workspace: { id: 'ws-1', name: 'app', repoFullName: 'o/r' },
    sourceBranch: 'dev',
    prodBranch: 'main',
    compositionSha: DEV,
    composition: c,
    defaultSelected: [...defaultSelection(c)],
    leftOut: [],
    candidate: null,
    merged: null,
    step: 'compose',
    lede: '',
    counts: { missions: 1, other: 1 },
    record: [],
    truncated: false,
    ...over,
  };
}

function harness(v: ReleaseFlowView, over: Partial<ComposeActionDeps> = {}) {
  const rows: any[] = [];
  const deps: ComposeActionDeps = {
    db: { insert: () => ({ values: async (row: any) => void rows.push(row) }) } as any,
    loadFlow: async () => ({ ok: true, view: v }),
    mergeThroughGate: mock(async () => ({ status: 200, body: { merged: true } })),
    recordAndDispatch: mock(async () => ({ ok: true as const, releaseId: 'rel-1', deduped: false, headSha: DEV, runUrl: 'run' })),
    dispatch: mock(async () => ({ runUrl: 'run', runsUrl: 'runs' }) as any),
    mergePr: mock(async () => ({ merged: true, message: 'merged' })),
    branchHead: async () => DEV,
    ...over,
  };
  return { deps, rows };
}

describe('include: a ready mission merges through the gated path only', () => {
  it('calls the dashboard merge route for the mission PR, never a raw merge, and records who', async () => {
    const { deps, rows } = harness(view());
    const res = await runComposeAction(target, 'user-1', { action: 'include', missionId: 'm3' }, deps);
    expect(res.status).toBe(200);
    expect(deps.mergeThroughGate).toHaveBeenCalledWith(30, 'ws-1');
    expect(deps.mergePr).not.toHaveBeenCalled();
    expect(rows).toEqual([expect.objectContaining({ step: 'include', outcome: 'succeeded', actorUserId: 'user-1', prNumber: 30, missionId: 'm3' })]);
  });

  it('a refusal from the gate is the answer: nothing else merges it', async () => {
    const { deps, rows } = harness(view(), { mergeThroughGate: mock(async () => ({ status: 409, body: { error: 'Merge refused: review verdict blocks' } })) });
    const res = await runComposeAction(target, 'user-1', { action: 'include', missionId: 'm3' }, deps);
    expect(res.status).toBe(409);
    expect(res.message).toContain('review verdict');
    expect(deps.mergePr).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ step: 'include', outcome: 'refused' });
  });

  it('a mission PR that is not approved and green cannot be included', async () => {
    const { deps } = harness(view());
    const res = await runComposeAction(target, 'user-1', { action: 'include', missionId: 'm4' }, deps);
    expect(res.status).toBe(409);
    expect(res.message).toContain('not ready');
    expect(deps.mergeThroughGate).not.toHaveBeenCalled();
  });

  it('nothing is included once a candidate is cut', async () => {
    const { deps } = harness(view({ candidate: candidate() }));
    const res = await runComposeAction(target, 'user-1', { action: 'include', missionId: 'm3' }, deps);
    expect(res.status).toBe(409);
    expect(deps.mergeThroughGate).not.toHaveBeenCalled();
  });
});

describe('cut', () => {
  it('dispatches the release workflow from the SHA the page showed', async () => {
    const v = view();
    const { deps, rows } = harness(v);
    const res = await runComposeAction(target, 'user-1', { action: 'cut', selected: v.defaultSelected, expectedSourceSha: DEV }, deps);
    expect(res.status).toBe(202);
    expect(deps.recordAndDispatch).toHaveBeenCalledWith(expect.objectContaining({ workflowFile: 'release.yml', ref: 'dev', inputs: {}, triggeredBy: 'user' }));
    expect(rows[0]).toMatchObject({ step: 'cut', outcome: 'pending', actorUserId: 'user-1' });
    expect(rows[0].detail).toMatchObject({ sourceSha: DEV, missions: 1, other: 1 });
  });

  it('refuses when dev moved since the page loaded', async () => {
    const v = view();
    const { deps } = harness(v, { branchHead: async () => 'e'.repeat(40) });
    const res = await runComposeAction(target, 'user-1', { action: 'cut', selected: v.defaultSelected, expectedSourceSha: DEV }, deps);
    expect(res.status).toBe(409);
    expect(res.message).toContain('moved');
    expect(deps.recordAndDispatch).not.toHaveBeenCalled();
  });

  it('leaving a mission out asks first, then passes its merge to the workflow as an exclusion', async () => {
    const v = view();
    const { deps } = harness(v);
    const first = await runComposeAction(target, 'user-1', { action: 'cut', selected: [prKey(11)], expectedSourceSha: DEV }, deps);
    expect(first.status).toBe(409);
    expect(first.needsConfirmation).toContain('reverts its merge on the candidate branch');
    expect(deps.recordAndDispatch).not.toHaveBeenCalled();

    const res = await runComposeAction(target, 'user-1', { action: 'cut', selected: [prKey(11)], expectedSourceSha: DEV, confirmed: true }, deps);
    expect(res.status).toBe(202);
    expect(deps.recordAndDispatch).toHaveBeenCalledWith(expect.objectContaining({ inputs: { exclude: 'a'.repeat(40), exclude_confirm: 'revert' } }));
  });

  it('a ready mission picked but not included is refused, not merged as a side effect', async () => {
    const v = view();
    const { deps } = harness(v);
    const res = await runComposeAction(target, 'user-1', { action: 'cut', selected: [...v.defaultSelected, missionKey('m3')], expectedSourceSha: DEV }, deps);
    expect(res.status).toBe(409);
    expect(res.message).toContain('Include Search first');
    expect(deps.mergeThroughGate).not.toHaveBeenCalled();
  });
});

describe('exclude: an amendment to the open candidate', () => {
  it('says the candidate SHA changes and its verification is void, and only acts once confirmed', async () => {
    const v = view({ candidate: candidate(), step: 'review' });
    const { deps, rows } = harness(v);
    const ask = await runComposeAction(target, 'user-1', { action: 'exclude', keys: [missionKey('m1')], expectedCandidateSha: CAND }, deps);
    expect(ask.status).toBe(409);
    expect(ask.needsConfirmation).toContain('new candidate SHA');
    expect(ask.needsConfirmation).toContain(`every check and approval on ${CAND.slice(0, 9)} is void`);
    expect(deps.dispatch).not.toHaveBeenCalled();

    const res = await runComposeAction(target, 'user-1', { action: 'exclude', keys: [missionKey('m1')], expectedCandidateSha: CAND, confirmed: true }, deps);
    expect(res.status).toBe(202);
    expect(deps.dispatch).toHaveBeenCalledWith(1, 'o', 'r', { workflowFile: 'release.yml', ref: 'dev', inputs: { exclude: 'a'.repeat(40), exclude_confirm: 'revert' } });
    expect(rows[0]).toMatchObject({ step: 'exclude', outcome: 'pending', version: '1.4.0', candidateSha: CAND, prNumber: 99 });
  });

  it('refuses against a candidate SHA the page did not show', async () => {
    const { deps } = harness(view({ candidate: candidate() }));
    const res = await runComposeAction(target, 'user-1', { action: 'exclude', keys: [missionKey('m1')], expectedCandidateSha: OLD, confirmed: true }, deps);
    expect(res.status).toBe(409);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });
});

describe('release: merge the candidate, pinned to its SHA', () => {
  it('merges only with every required check passing and an approval on the exact SHA', async () => {
    const { deps, rows } = harness(view({ candidate: candidate(), step: 'review' }));
    const res = await runComposeAction(target, 'user-1', { action: 'release', expectedCandidateSha: CAND }, deps);
    expect(res.status).toBe(200);
    expect(res.message).toContain('released when production runs it');
    expect(deps.mergePr).toHaveBeenCalledWith(1, 'o/r', 99, 'merge', CAND, 'user-1');
    expect(rows[0]).toMatchObject({ step: 'release', outcome: 'succeeded', candidateSha: CAND });
  });

  it('an approval left on the previous candidate SHA does not release the amended one', async () => {
    const amended = candidate({
      amendment: 1,
      previousCandidateSha: OLD,
      verdict: candidateVerdict({
        candidateSha: CAND,
        required: REQUIRED_CANDIDATE_CHECKS,
        checks: REQUIRED_CANDIDATE_CHECKS.map((name) => ({ name, sha: CAND, state: 'passing' as const, url: null })),
        reviews: [{ author: 'owner', state: 'APPROVED', sha: OLD }],
      }),
    });
    const { deps, rows } = harness(view({ candidate: amended }));
    const res = await runComposeAction(target, 'user-1', { action: 'release', expectedCandidateSha: CAND }, deps);
    expect(res.status).toBe(409);
    expect(res.message).toContain('no approval stands');
    expect(deps.mergePr).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ step: 'release', outcome: 'refused' });
  });

  it('checks that passed on an earlier SHA do not count', async () => {
    const c = candidate({
      verdict: candidateVerdict({
        candidateSha: CAND,
        required: REQUIRED_CANDIDATE_CHECKS,
        checks: REQUIRED_CANDIDATE_CHECKS.map((name) => ({ name, sha: OLD, state: 'passing' as const, url: null })),
        reviews: [{ author: 'owner', state: 'APPROVED', sha: CAND }],
      }),
    });
    const { deps } = harness(view({ candidate: c }));
    const res = await runComposeAction(target, 'user-1', { action: 'release', expectedCandidateSha: CAND }, deps);
    expect(res.status).toBe(409);
    expect(deps.mergePr).not.toHaveBeenCalled();
  });
});

describe('confirm: released only when production runs the merge', () => {
  const merged = (over: Partial<MergedCandidateState>): MergedCandidateState => ({
    prNumber: 99,
    url: 'u99',
    version: '1.4.0',
    mergeSha: MERGE,
    mergedAt: '2026-10-12T00:00:00Z',
    deployedSha: null,
    production: 'awaiting_production',
    confirmed: false,
    ...over,
  });

  it('a merged candidate that production does not run yet is not marked released', async () => {
    const { deps, rows } = harness(view({ merged: merged({ deployedSha: 'x'.repeat(40) }), step: 'release' }));
    const res = await runComposeAction(target, 'user-1', { action: 'confirm' }, deps);
    expect(res.status).toBe(409);
    expect(res.message).toContain('Not marked released');
    expect(rows[0]).toMatchObject({ step: 'confirm_production', outcome: 'refused' });
  });

  it('no deployed SHA reported means not released', async () => {
    const { deps, rows } = harness(view({ merged: merged({}), step: 'release' }));
    const res = await runComposeAction(target, 'user-1', { action: 'confirm' }, deps);
    expect(res.status).toBe(409);
    expect(rows[0].outcome).toBe('refused');
  });

  it('production running the merge commit marks it released, with who and the SHA', async () => {
    const { deps, rows } = harness(view({ merged: merged({ deployedSha: MERGE, production: 'released' }), step: 'released' }));
    const res = await runComposeAction(target, 'user-1', { action: 'confirm' }, deps);
    expect(res.status).toBe(200);
    expect(rows[0]).toMatchObject({ step: 'confirm_production', outcome: 'succeeded', actorUserId: 'user-1', version: '1.4.0' });
    expect(rows[0].detail).toEqual({ mergeSha: MERGE, deployedSha: MERGE });
  });

  it('the next candidate is not cut while the last one is unconfirmed', async () => {
    const v = view({ merged: merged({}) });
    const { deps } = harness(v);
    const res = await runComposeAction(target, 'user-1', { action: 'cut', selected: v.defaultSelected, expectedSourceSha: DEV }, deps);
    expect(res.status).toBe(409);
    expect(deps.recordAndDispatch).not.toHaveBeenCalled();
  });
});

describe('parseComposeAction', () => {
  it('accepts the five actions and nothing else', () => {
    expect(parseComposeAction({ action: 'include', missionId: 'm' })).toEqual({ action: 'include', missionId: 'm' });
    expect(parseComposeAction({ action: 'cut', selected: ['pr:1'], expectedSourceSha: 's', confirmed: true })).toEqual({ action: 'cut', selected: ['pr:1'], expectedSourceSha: 's', confirmed: true });
    expect(parseComposeAction({ action: 'release', expectedCandidateSha: 's' })).toEqual({ action: 'release', expectedCandidateSha: 's' });
    expect(parseComposeAction({ action: 'confirm' })).toEqual({ action: 'confirm' });
    expect(parseComposeAction({ action: 'cut', selected: 'pr:1', expectedSourceSha: 's' })).toBeNull();
    expect(parseComposeAction({ action: 'merge' })).toBeNull();
  });
});
