/**
 * AC-13 (workflow-kernel-library.md §4): a PR with no delivery is adopted
 * before a worker door merges it, and a PR nothing can adopt is refused, never
 * merged on a legacy arm.
 */
import { describe, expect, mock, test } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));

const { adoptBeforeMerge: adoptRaw, mergeOutsideKernel } = await import('./merge-adoption');

const BASE = { workspaceId: 'ws', installationId: 1, repoFullName: 'acme/w', prNumber: 7, taskId: 'task-1', door: 'dashboard' };
const CALL = { principal: { kind: 'user' as const, id: 'u1' } };

/** A store answering the one resolver read with `row` (or none). */
const execOf = (row: { delivery_id: string; authority: string } | null) => mock(async () => ({ rows: row ? [row] : [] }));

const RELEASE_CONFIG = {
  enabled: true, strategy: 'workflow_dispatch', prodBranch: 'main', releaseBranch: 'dev',
  candidate: { branches: ['release/v*'], sourceBranch: 'dev', authors: ['github-actions[bot]'] },
};
const ORDINARY = { headRef: 'feat/x', baseRef: 'dev', headSha: 'H1', author: 'buildd-app[bot]', headRepoFullName: 'acme/w', baseRepoFullName: 'acme/w', body: '' };
const candidateMeta = (sha: string) => `Release v1.2.3\n<!-- release-candidate ${JSON.stringify({ schema: 1, version: 'v1.2.3', branch: 'release/v1.2.3', sourceRef: 'dev', sourceSha: 'S1', candidateSha: sha, baseRef: 'main' })} -->`;
const CANDIDATE = { headRef: 'release/v1.2.3', baseRef: 'main', headSha: 'C1', author: 'github-actions[bot]', headRepoFullName: 'acme/w', baseRepoFullName: 'acme/w', body: candidateMeta('C1') };

type Deps = NonNullable<Parameters<typeof adoptRaw>[2]>;
/** The helper with an ordinary same-repo PR in a kernel-on workspace, unless a test says otherwise. */
const adoptBeforeMerge = (p: Parameters<typeof adoptRaw>[0], c: Parameters<typeof adoptRaw>[1], d: Deps = {}) => adoptRaw(p, c, {
  workspace: async () => ({ gitConfig: {}, releaseConfig: RELEASE_CONFIG }),
  readPr: async () => ORDINARY,
  ...d,
});

describe('adoptBeforeMerge (AC-13)', () => {
  test('a PR the kernel already owns: nothing opened, the door lands through the kernel', async () => {
    const open = mock(async () => ({ owned: true, deliveryId: 'x' }));
    const r = await adoptBeforeMerge(BASE, CALL, { exec: execOf({ delivery_id: 'd1', authority: 'kernel' }), open });
    expect(r).toEqual({ kind: 'kernel', deliveryId: 'd1', adopted: false });
    expect(open).not.toHaveBeenCalled();
  });

  test('a delivery released to legacy stays legacy (sticky release, kill switch)', async () => {
    const open = mock(async () => ({ owned: true, deliveryId: 'x' }));
    const r = await adoptBeforeMerge(BASE, CALL, { exec: execOf({ delivery_id: 'd1', authority: 'legacy' }), open });
    expect(r).toEqual({ kind: 'legacy', reason: 'released' });
    expect(open).not.toHaveBeenCalled();
  });

  test('a PR with no delivery is opened with the owner task, under the door\'s principal, and lands through the kernel', async () => {
    const open = mock(async () => ({ owned: true, deliveryId: 'd2' }));
    const ownerOf = mock(async () => 'owner-task');
    const r = await adoptBeforeMerge(BASE, CALL, { exec: execOf(null), open, ownerOf });
    expect(r).toEqual({ kind: 'kernel', deliveryId: 'd2', adopted: true });
    expect(ownerOf).toHaveBeenCalledWith('task-1');
    expect(open).toHaveBeenCalledWith(
      { workspaceId: 'ws', ownerTaskId: 'owner-task', repoFullName: 'acme/w', prNumber: 7, installationId: 1, source: 'dashboard:adopt' },
      CALL,
    );
  });

  test('the kill switch off: the legacy arm, as designed', async () => {
    const r = await adoptBeforeMerge(BASE, CALL, { exec: execOf(null), open: async () => ({ owned: false, reason: 'kernel_off' }), ownerOf: async (t) => t });
    expect(r).toEqual({ kind: 'legacy', reason: 'kernel_off' });
  });

  test.each([
    ['review_task'], ['attempt_task'], ['owner_bound_to_other_pr'], ['no_task'], ['released'], ['bind_fork'], ['open_rejected'],
  ])('adoption answered %s: the merge is refused, naming it', async (reason) => {
    const r = await adoptBeforeMerge(BASE, CALL, { exec: execOf(null), open: async () => ({ owned: false, reason }), ownerOf: async (t) => t });
    expect(r.kind).toBe('refused');
    expect(r.kind === 'refused' && r.reason).toBe(`adoption_failed:${reason}`);
    expect(r.kind === 'refused' && r.message).toContain('nothing was merged');
  });

  test('no task owns the PR: refused without asking the kernel', async () => {
    const open = mock(async () => ({ owned: true, deliveryId: 'x' }));
    const r = await adoptBeforeMerge({ ...BASE, taskId: null }, CALL, { exec: execOf(null), open });
    expect(r.kind === 'refused' && r.reason).toBe('adoption_failed:no_owner_task');
    expect(open).not.toHaveBeenCalled();
  });

  test('the control plane does not answer: refused, never the legacy arm', async () => {
    const r = await adoptBeforeMerge(BASE, CALL, { exec: execOf(null), open: async () => { throw new Error('control plane unavailable'); }, ownerOf: async (t) => t });
    expect(r.kind === 'refused' && r.reason).toBe('adoption_failed:adoption_unavailable');
  });

  test('the resolver read fails: refused, never the legacy arm', async () => {
    const exec = mock(async () => { throw new Error('db down'); });
    const r = await adoptBeforeMerge(BASE, CALL, { exec, open: async () => ({ owned: true, deliveryId: 'x' }) });
    expect(r.kind === 'refused' && r.reason).toBe('adoption_failed:adoption_unavailable');
  });

  test('an unreadable owner walk falls back to the door\'s own task', async () => {
    const open = mock(async () => ({ owned: true, deliveryId: 'd3' }));
    await adoptBeforeMerge(BASE, CALL, { exec: execOf(null), open, ownerOf: async () => { throw new Error('x'); } });
    expect((open.mock.calls[0] as unknown as [{ ownerTaskId: string }])[0].ownerTaskId).toBe('task-1');
  });

  // Review of #5167: a release PR must never get a delivery (its candidate status, the release
  // bookkeeping and the frozen branch stay the release gate's).
  test('a trusted frozen candidate opens no delivery: the release gate merges it', async () => {
    const open = mock(async () => ({ owned: true, deliveryId: 'x' }));
    const r = await adoptBeforeMerge(BASE, CALL, { exec: execOf(null), open, readPr: async () => CANDIDATE });
    expect(r).toEqual({ kind: 'gate', why: 'release' });
    expect(open).not.toHaveBeenCalled();
  });

  test('the legacy release PR (releaseBranch into prodBranch) opens no delivery', async () => {
    const open = mock(async () => ({ owned: true, deliveryId: 'x' }));
    const r = await adoptBeforeMerge(BASE, CALL, { exec: execOf(null), open, readPr: async () => ({ ...ORDINARY, headRef: 'dev', baseRef: 'main' }) });
    expect(r).toEqual({ kind: 'gate', why: 'release' });
    expect(open).not.toHaveBeenCalled();
  });

  test('a candidate-shaped PR by an author the workflow does not trust is an ordinary PR: adopted', async () => {
    const open = mock(async () => ({ owned: true, deliveryId: 'd9' }));
    const r = await adoptBeforeMerge(BASE, CALL, { exec: execOf(null), open, ownerOf: async (t) => t, readPr: async () => ({ ...CANDIDATE, author: 'someone' }) });
    expect(r).toEqual({ kind: 'kernel', deliveryId: 'd9', adopted: true });
  });

  test('a dependency bot\'s PR opens no delivery (the bot owns its branch): the release gate merges it', async () => {
    const open = mock(async () => ({ owned: true, deliveryId: 'x' }));
    const r = await adoptBeforeMerge(BASE, CALL, { exec: execOf(null), open, readPr: async () => ({ ...ORDINARY, author: 'renovate[bot]' }) });
    expect(r).toEqual({ kind: 'gate', why: 'dependency_bot' });
    expect(open).not.toHaveBeenCalled();
  });

  test('a fork PR is refused by every buildd door, saying it merges on GitHub; nothing is opened', async () => {
    const open = mock(async () => ({ owned: true, deliveryId: 'x' }));
    const r = await adoptBeforeMerge(BASE, CALL, { exec: execOf(null), open, readPr: async () => ({ ...ORDINARY, headRepoFullName: 'someone/w' }) });
    expect(r.kind === 'refused' && r.reason).toBe('adoption_failed:fork');
    expect(r.kind === 'refused' && r.message).toContain('fork');
    expect(open).not.toHaveBeenCalled();
  });

  test('the kill switch off answers legacy before anything is read from GitHub', async () => {
    const readPr = mock(async () => CANDIDATE);
    const r = await adoptBeforeMerge(BASE, CALL, { exec: execOf(null), workspace: async () => ({ gitConfig: { workflowKernel: false }, releaseConfig: RELEASE_CONFIG }), readPr });
    expect(r).toEqual({ kind: 'legacy', reason: 'kernel_off' });
    expect(readPr).not.toHaveBeenCalled();
  });

  test('an unreadable PR is refused, never classified as ordinary', async () => {
    const open = mock(async () => ({ owned: true, deliveryId: 'x' }));
    const r = await adoptBeforeMerge(BASE, CALL, { exec: execOf(null), open, readPr: async () => null });
    expect(r.kind === 'refused' && r.reason).toBe('adoption_failed:adoption_unavailable');
    expect(open).not.toHaveBeenCalled();
  });
});

describe('mergeOutsideKernel (the release gate for a PR adoption kept out of the kernel)', () => {
  test('merges through mergeReleasePrPinned at the checked head, in the door\'s result shape', async () => {
    const calls: any[] = [];
    const r = await mergeOutsideKernel(
      { workspaceId: 'ws', installationId: 1, repoFullName: 'acme/w', prNumber: 7, headSha: 'C1', mergeMethod: 'merge', door: 'dashboard', actorUserId: 'u1', taskId: 't' },
      { merge: (async (p: any) => { calls.push(p); return { merged: true, sha: 'M', message: 'PR merged', via: 'pinned' }; }) as never },
    );
    expect(r).toEqual({ merged: true, message: 'PR merged' });
    expect(calls[0]).toMatchObject({ verifiedHeadSha: 'C1', mergeMethod: 'merge', surface: 'dashboard', actorUserId: 'u1' });
  });

  test('a review hold or a lost answer is not a merge', async () => {
    const held = await mergeOutsideKernel(
      { workspaceId: 'ws', installationId: 1, repoFullName: 'acme/w', prNumber: 7, headSha: 'C1', mergeMethod: 'merge', door: 'merge_pr' },
      { merge: (async () => ({ merged: false, refused: 'review', message: 'the review gate holds it' })) as never },
    );
    expect(held).toEqual({ merged: false, message: 'the review gate holds it' });
    const lost = await mergeOutsideKernel(
      { workspaceId: 'ws', installationId: 1, repoFullName: 'acme/w', prNumber: 7, headSha: 'C1', mergeMethod: 'merge', door: 'merge_pr' },
      { merge: (async () => ({ merged: false, refused: 'merge_failed', message: 'timeout', indeterminate: true })) as never },
    );
    expect(lost).toEqual({ merged: false, message: 'timeout', indeterminate: true });
  });
});
