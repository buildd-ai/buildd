/**
 * Composition attestation (docs/specs/workflow-state-kernel.md §5.9): a
 * release / integration PR built only from changes reviewed at their own head
 * is approved by composition, never by a borrowed verdict; any novel delta is
 * reviewed on its own; anything the check cannot see fails closed.
 */
import { describe, expect, test } from 'bun:test';
import { buildCompositionAttestation, collectComposition, isCompositionPr, isReleaseArtifactCommit, patchIdOf, type CompositionInput, type ConstituentDelivery, type FileDiff } from './review-composition';
import { headCoverage, reduce } from './reducer';
import type { DeliverySnapshot, KernelView, RoundSnapshot } from './types';

const REPO = 'acme/widgets';
const approved = (id: string, head: string, extra: string[] = []): ConstituentDelivery => ({
  deliveryId: `d-${id}`, approvedHeads: [head, ...extra],
  rounds: [{ id: `r-${id}`, headSha: head, status: 'decided', effectiveVerdict: 'approve' }],
});
/** One file's diff as GitHub returns it (commit or compare `files[]`). */
const fd = (filename: string, patch = `@@ -1 +1 @@\n-old ${filename}\n+new ${filename}`): FileDiff => ({ filename, status: 'modified', patch });
const base = (o: Partial<CompositionInput> = {}): CompositionInput => ({
  repoFullName: REPO, prNumber: 50, baseSha: 'B0', aggregateHeadSha: 'AGG',
  commits: [
    { sha: 'S1', parents: ['B0'], message: 'feat: one (#11)', files: ['a.ts'], diff: [fd('a.ts')] },
    { sha: 'S2', parents: ['S1'], message: 'fix: two (#12)', files: ['b.ts'], diff: [fd('b.ts')] },
    { sha: 'V1', parents: ['S2'], message: 'chore: bump version to v1.2.3', files: ['apps/web/package.json', 'CHANGELOG.md'] },
  ],
  aggregateFiles: ['a.ts', 'b.ts', 'apps/web/package.json', 'CHANGELOG.md'],
  constituentsByCommit: {
    S1: { prNumber: 11, mergedHeadSha: 'P11', delivery: approved('11', 'P11') },
    S2: { prNumber: 12, mergedHeadSha: 'P12b', delivery: approved('12', 'P12a', ['P12b']) },
  },
  // What each constituent's reviewed head changed, read independently of the landed commit.
  reviewedDiffs: { S1: [fd('a.ts')], S2: [fd('b.ts')] },
  now: '2026-10-07T00:00:00Z',
  ...o,
});

const D = (o: Partial<DeliverySnapshot> = {}): DeliverySnapshot => ({
  id: 'agg', workspaceId: 'w1', ownerTaskId: 't1', repoFullName: REPO, prNumber: 50, baseRef: 'dev',
  state: 'AWAITING_REVIEW', stateReason: null, version: 3, currentHeadSha: 'AGG', currentRound: 1, maxRounds: 3,
  boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [], approvalBasis: null,
  compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
  mergeCommitSha: null, supersededByPr: null, ...o,
});
const R = (o: Partial<RoundSnapshot> = {}): RoundSnapshot => ({ id: 'r1', round: 1, headSha: 'AGG', kind: 'full', status: 'queued', verdict: null, effectiveVerdict: null, failureCount: 0, ...o });
let seq = 0;
const run = (built: ReturnType<typeof buildCompositionAttestation>, view: KernelView = { delivery: D(), rounds: [R()], attempts: [] }) =>
  reduce(view, { type: 'CompositionAttested', actor: 'kernel', attestation: built.attestation, constituents: built.constituentsEvidence }, { newId: () => `n${++seq}` });

describe('isCompositionPr', () => {
  test('a mission integration PR into trunk and a release PR are composed', () => {
    expect(isCompositionPr({ headRef: 'mission/x', baseRef: 'dev', missionWorkingBranch: 'mission/x' })).toBe(true);
    expect(isCompositionPr({ headRef: 'dev', baseRef: 'main', releaseConfig: { enabled: true, releaseBranch: 'dev', prodBranch: 'main' } as never })).toBe(true);
  });
  test('ordinary PRs, including task PRs into a mission branch, are not', () => {
    expect(isCompositionPr({ headRef: 'buildd/abc-fix', baseRef: 'mission/x', missionWorkingBranch: 'mission/x' })).toBe(false);
    expect(isCompositionPr({ headRef: 'buildd/abc-fix', baseRef: 'dev' })).toBe(false);
    expect(isCompositionPr({ headRef: 'dev', baseRef: 'main', releaseConfig: { enabled: false, releaseBranch: 'dev', prodBranch: 'main' } as never })).toBe(false);
  });
});

describe('buildCompositionAttestation', () => {
  test('zero novel delta: constituents at their reviewed (or recorded-equivalent) heads, the version bump an artifact', () => {
    const b = buildCompositionAttestation(base());
    expect(b.attestation.novelDelta).toEqual({ result: 'none' });
    expect(b.attestation.method).toBe('patch_set_equal');
    expect(b.attestation.constituents.map((c) => [c.prNumber, c.reviewedHeadSha, c.mergedHeadSha, c.landedSha, c.equivalentHeadShas])).toEqual([
      [11, 'P11', 'P11', 'S1', []],
      [12, 'P12a', 'P12b', 'S2', ['P12b']],
    ]);
    // The proof is computed: two patch-ids from two independent reads, equal and non-empty.
    for (const c of b.attestation.constituents) {
      expect(c.landedPatchId).toMatch(/^[0-9a-f]{64}$/);
      expect(c.landedPatchId).toBe(c.reviewedPatchId);
    }
  });

  test('regression: a squash commit whose patch differs from the reviewed head (conflict resolved while merging) is novel, not a constituent', () => {
    // C = S1 is associated with PR #11 (approved at P11), but what landed is not what was reviewed.
    const b = buildCompositionAttestation(base({
      commits: [{ ...base().commits![0], diff: [fd('a.ts', '@@ -1 +1 @@\n-old a.ts\n+resolved by hand')] }, ...base().commits!.slice(1)],
    }));
    expect(b.attestation.novelDelta).toEqual({ result: 'present', paths: ['a.ts'] });
    expect(b.novelCommits).toEqual([{ sha: 'S1', reason: 'pr_11_landed_patch_differs', paths: ['a.ts'] }]);
    expect(b.attestation.constituents.map((c) => c.prNumber)).toEqual([12]);
  });

  test('only the files whose landed patch differs are owed a review', () => {
    const b = buildCompositionAttestation(base({
      commits: [{ ...base().commits![0], files: ['a.ts', 'a2.ts'], diff: [fd('a.ts'), fd('a2.ts', '@@ -3 +3 @@\n-x\n+y-resolved')] }, ...base().commits!.slice(1)],
      aggregateFiles: [...base().aggregateFiles!, 'a2.ts'],
      reviewedDiffs: { S1: [fd('a.ts'), fd('a2.ts', '@@ -3 +3 @@\n-x\n+y')], S2: [fd('b.ts')] },
    }));
    expect(b.attestation.novelDelta).toEqual({ result: 'present', paths: ['a2.ts'] });
  });

  test('a file the landed commit has and the reviewed head does not (or the reverse) is novel', () => {
    const extra = buildCompositionAttestation(base({
      commits: [{ ...base().commits![0], files: ['a.ts', 'sneak.ts'], diff: [fd('a.ts'), fd('sneak.ts')] }, ...base().commits!.slice(1)],
      aggregateFiles: [...base().aggregateFiles!, 'sneak.ts'],
    }));
    expect(extra.attestation.novelDelta).toEqual({ result: 'present', paths: ['sneak.ts'] });
    // The reviewed head also changed a file that never landed: what landed is not what was reviewed.
    const missing = buildCompositionAttestation(base({ reviewedDiffs: { S1: [fd('a.ts'), fd('dropped.ts')], S2: [fd('b.ts')] } }));
    expect(missing.attestation.novelDelta).toEqual({ result: 'present', paths: ['a.ts'] });
  });

  test('a patch read that is unavailable fails closed, never none', () => {
    const noLanded = base();
    noLanded.commits![0] = { ...noLanded.commits![0], diff: null };
    expect(buildCompositionAttestation(noLanded).attestation.novelDelta).toEqual({ result: 'unverifiable', reason: 'landed_patch_unreadable:S1' });
    expect(buildCompositionAttestation(base({ reviewedDiffs: { S2: [fd('b.ts')] } })).attestation.novelDelta)
      .toEqual({ result: 'unverifiable', reason: 'reviewed_patch_unreadable:S1' });
  });

  test('patch-id ignores hunk positions and context, not content', () => {
    const a = patchIdOf([{ filename: 'x.ts', status: 'modified', patch: '@@ -10,3 +10,3 @@ fn\n ctx one\n-old\n+new\n ctx two' }]);
    const moved = patchIdOf([{ filename: 'x.ts', status: 'modified', patch: '@@ -42,3 +42,3 @@ other\n different ctx\n-old\n+new\n more ctx' }]);
    const changed = patchIdOf([{ filename: 'x.ts', status: 'modified', patch: '@@ -10,3 +10,3 @@ fn\n ctx one\n-old\n+newer\n ctx two' }]);
    expect(a.id).toBe(moved.id);
    expect(a.id).not.toBe(changed.id);
    // A file GitHub gives no patch for (binary, too large) compares by its resulting blob.
    const blob = (sha?: string) => patchIdOf([{ filename: 'i.png', status: 'modified', blobSha: sha }]);
    expect(blob('b1').id).toBe(blob('b1').id);
    expect(blob('b1').id).not.toBe(blob('b2').id);
    expect(blob(undefined).unreadable).toEqual(['i.png']);
  });

  test('→ reducer: APPROVED on composition; approved_heads untouched; open round superseded', () => {
    const dec = run(buildCompositionAttestation(base()));
    if (dec.result !== 'apply') throw new Error(`${dec.result}: ${(dec as { reason?: string }).reason}`);
    expect(dec.toState).toBe('APPROVED');
    expect(dec.patch.approvalBasis).toBe('composition');
    expect(dec.patch.compositionHeads).toEqual(['AGG']);
    expect(dec.patch.approvedHeads).toBeUndefined();
    expect(dec.rounds).toEqual([{ op: 'update', roundId: 'r1', whenStatus: ['queued', 'reviewing'], set: { status: 'superseded' } }]);
    expect(dec.effects.some((e) => e.kind === 'dispatch_review')).toBe(false);
    // An ordinary verdict lookup is never satisfied by composition.
    expect(headCoverage({ approvedHeads: [], approvalBasis: 'composition', compositionHeads: ['AGG'] }, 'AGG')).toBe('composition');
  });

  test('a manual edit on the composed branch is a novel delta of exactly its paths → a delta round', () => {
    const b = buildCompositionAttestation(base({
      commits: [...base().commits!, { sha: 'X1', parents: ['V1'], message: 'tweak', files: ['c.ts'] }],
      aggregateFiles: [...base().aggregateFiles!, 'c.ts'],
    }));
    expect(b.attestation.novelDelta).toEqual({ result: 'present', paths: ['c.ts'] });
    expect(b.novelCommits).toEqual([{ sha: 'X1', reason: 'direct_commit', paths: ['c.ts'] }]);
    const dec = run(b);
    if (dec.result !== 'apply') throw new Error(dec.result);
    expect(dec.toState).toBe('AWAITING_REVIEW');
    const ins = dec.rounds.find((r) => r.op === 'insert');
    expect(ins).toMatchObject({ kind: 'delta', scope: { novelDeltaPaths: ['c.ts'], composition: true } });
  });

  test('a constituent reviewed only on the legacy path is novel, not inherited', () => {
    const b = buildCompositionAttestation(base({ constituentsByCommit: { ...base().constituentsByCommit, S2: { prNumber: 12, mergedHeadSha: 'P12b', delivery: null } } }));
    expect(b.attestation.novelDelta).toEqual({ result: 'present', paths: ['b.ts'] });
  });

  test('a constituent merged at a head no approve covers is novel', () => {
    const b = buildCompositionAttestation(base({ constituentsByCommit: { ...base().constituentsByCommit, S1: { prNumber: 11, mergedHeadSha: 'P11-later', delivery: approved('11', 'P11') } } }));
    expect(b.attestation.novelDelta).toEqual({ result: 'present', paths: ['a.ts'] });
  });

  test('a merge of the base keeps only files both sides changed as novel', () => {
    const b = buildCompositionAttestation(base({
      commits: [...base().commits!, { sha: 'M1', parents: ['V1', 'DEV9'], message: 'Merge dev', files: ['a.ts', 'z-from-dev.ts'], mergeParentsInBase: true }],
    }));
    expect(b.attestation.novelDelta).toEqual({ result: 'present', paths: ['a.ts'] });
  });

  test('fails closed: truncated compare, unreadable commit, unexplained aggregate path, no constituents', () => {
    expect(buildCompositionAttestation(base({ commits: null })).attestation.novelDelta.result).toBe('unverifiable');
    expect(buildCompositionAttestation(base({ aggregateFiles: null })).attestation.novelDelta.result).toBe('unverifiable');
    const unreadable = base();
    unreadable.commits![0] = { ...unreadable.commits![0], files: null };
    expect(buildCompositionAttestation(unreadable).attestation.novelDelta.result).toBe('unverifiable');
    expect(buildCompositionAttestation(base({ aggregateFiles: [...base().aggregateFiles!, 'ghost.ts'] })).attestation.novelDelta).toEqual({ result: 'unverifiable', reason: 'aggregate_not_explained_by_commits' });
    expect(buildCompositionAttestation(base({ constituentsByCommit: {} })).attestation.novelDelta).toEqual({ result: 'unverifiable', reason: 'no_reviewed_constituents' });
    // The reducer claims nothing for an unverifiable attestation.
    expect(run(buildCompositionAttestation(base({ commits: null }))).result).toBe('rejected');
  });

  test('the reducer refuses a constituent whose patch-ids differ, or whose round belongs to another PR', () => {
    const forged = buildCompositionAttestation(base());
    forged.attestation.constituents[0] = { ...forged.attestation.constituents[0], reviewedPatchId: 'f'.repeat(64) };
    expect((run(forged) as { missing: string[] }).missing).toEqual(['constituent_patch_unproven:r-11']);
    const foreign = buildCompositionAttestation(base());
    foreign.constituentsEvidence[0] = { ...foreign.constituentsEvidence[0], prNumber: 99, deliveryId: 'd-99' };
    expect((run(foreign) as { missing: string[] }).missing).toEqual(['constituent_round_foreign:r-11']);
  });

  test('a stale constituent round (head mismatch) is rejected by the reducer', () => {
    const b = buildCompositionAttestation(base());
    b.constituentsEvidence[0] = { ...b.constituentsEvidence[0], roundHeadSha: 'OTHER' };
    const dec = run(b);
    expect(dec.result).toBe('rejected');
    expect((dec as { reason: string }).reason).toBe('composition_not_verified');
  });

  test('release artifacts are recognised only by subject AND path', () => {
    expect(isReleaseArtifactCommit({ message: 'chore: bump version to v1.2.3', parents: ['x'], files: ['package.json', 'apps/web/package.json'] })).toBe(true);
    expect(isReleaseArtifactCommit({ message: 'chore: bump version to v1.2.3', parents: ['x'], files: ['package.json', 'src/a.ts'] })).toBe(false);
    expect(isReleaseArtifactCommit({ message: 'feat: x', parents: ['x'], files: ['CHANGELOG.md'] })).toBe(false);
  });
});

describe('collectComposition (GitHub + ledger read)', () => {
  /** A compare of S1 (squash of PR #11, reviewed at P11) and the version bump; `landedPatch` is what the squash really changed. */
  const composedApi = (landedPatch: string, reads: string[] = []) => async (_i: number, path: string): Promise<unknown> => {
    reads.push(path);
    if (path.startsWith(`/repos/${REPO}/compare/dev...AGG`)) return {
      merge_base_commit: { sha: 'B0' }, base_commit: { sha: 'B9' }, total_commits: 2,
      commits: [{ sha: 'S1', parents: [{ sha: 'B0' }], commit: { message: 'feat: one' } }, { sha: 'V1', parents: [{ sha: 'S1' }], commit: { message: 'chore: bump version to v1.0.1' } }],
      files: [{ filename: 'a.ts' }, { filename: 'package.json' }],
    };
    if (path === `/repos/${REPO}/commits/S1`) return { files: [{ filename: 'a.ts', status: 'modified', patch: landedPatch, sha: 'blobA' }] };
    if (path === `/repos/${REPO}/commits/V1`) return { files: [{ filename: 'package.json', status: 'modified', patch: '@@ -1 +1 @@\n-1.0.0\n+1.0.1' }] };
    if (path === `/repos/${REPO}/commits/S1/pulls`) return [{ number: 11, merged_at: '2026-10-06T00:00:00Z', base: { ref: 'mission/x' }, head: { sha: 'P11' } }];
    if (path === `/repos/${REPO}/commits/V1/pulls`) return [];
    // The reviewed head's own diff, against the landed commit's parent.
    if (path === `/repos/${REPO}/compare/B0...P11`) return { files: [{ filename: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-x\n+reviewed', sha: 'blobA' }] };
    throw new Error(`unexpected ${path}`);
  };
  const ledger = async () => ({ rows: [{ id: 'd-11', pr_number: 11, approved_heads: ['P11'], rounds: [{ id: 'r-11', head_sha: 'P11', status: 'decided', effective_verdict: 'approve' }] }] });
  const collect = (api: ReturnType<typeof composedApi>) => collectComposition({ api, exec: ledger, installationId: 1, workspaceId: 'w1', repoFullName: REPO, prNumber: 50, baseRef: 'dev', headRef: 'mission/x', aggregateHeadSha: 'AGG' });

  test('maps compare commits to merged constituent PRs and their kernel rounds, and proves each landed patch', async () => {
    const reads: string[] = [];
    const b = await collect(composedApi('@@ -7 +7 @@\n-x\n+reviewed', reads));
    expect(reads).toContain(`/repos/${REPO}/compare/B0...P11`);
    expect(b.attestation.novelDelta).toEqual({ result: 'none' });
    expect(b.attestation.baseSha).toBe('B0');
    const [c] = b.attestation.constituents;
    expect(c).toMatchObject({ deliveryId: 'd-11', roundId: 'r-11', prNumber: 11, reviewedHeadSha: 'P11', equivalentHeadShas: [], mergedHeadSha: 'P11', landedSha: 'S1' });
    expect(c.landedPatchId).toBe(c.reviewedPatchId);
    expect(b.constituentsEvidence[0]).toMatchObject({ deliveryId: 'd-11', prNumber: 11, repoFullName: REPO });
  });

  test('regression: the squash that GitHub associates with an approved PR but whose patch differs is a novel delta', async () => {
    const b = await collect(composedApi('@@ -1 +1 @@\n-x\n+conflict resolved differently'));
    // Its only constituent is not credited, so nothing is reviewed already: full review, never 'none'.
    expect(b.attestation.novelDelta).toEqual({ result: 'unverifiable', reason: 'no_reviewed_constituents' });
    expect(b.novelCommits).toEqual([{ sha: 'S1', reason: 'pr_11_landed_patch_differs', paths: ['a.ts'] }]);
    expect(b.attestation.constituents).toEqual([]);
  });

  test('an unreadable reviewed diff fails closed', async () => {
    const inner = composedApi('@@ -1 +1 @@\n-x\n+reviewed');
    const api = async (i: number, path: string) => (path.endsWith('/compare/B0...P11') ? null : inner(i, path));
    expect((await collect(api)).attestation.novelDelta.result).toBe('unverifiable');
  });

  test('a compare at the commit cap is truncated → unverifiable', async () => {
    const api = async (_i: number, path: string): Promise<unknown> => {
      if (path.includes('/compare/')) return { merge_base_commit: { sha: 'B0' }, total_commits: 400, commits: [], files: [] };
      return null;
    };
    const b = await collectComposition({ api, exec: async () => ({ rows: [] }), installationId: 1, workspaceId: 'w1', repoFullName: REPO, prNumber: 50, baseRef: 'dev', headRef: 'mission/x', aggregateHeadSha: 'AGG' });
    expect(b.attestation.novelDelta.result).toBe('unverifiable');
  });
});
