/**
 * The release doors' merge (workflow-kernel-library.md §4, AC-16): D8, D9 and
 * D10 each take the review gate and merge only the head they verified.
 */
import { describe, expect, mock, test } from 'bun:test';
import { mergeReleasePrPinned, type PinnedMergeInput } from './pinned-merge';

const input = (o: Partial<PinnedMergeInput> = {}): PinnedMergeInput => ({
  workspaceId: 'ws', installationId: 9, repoFullName: 'o/r', prNumber: 47, verifiedHeadSha: 'verified1', mergeMethod: 'merge', surface: 'release compose', ...o,
});

function github(pr: Record<string, unknown> | null, merge: (body: Record<string, unknown>) => unknown = () => ({ sha: 'mergesha1', merged: true })) {
  const calls: Array<{ path: string; method: string; body: Record<string, unknown> | null }> = [];
  const api = mock(async (_i: number, path: string, opts?: RequestInit) => {
    const body = opts?.body ? JSON.parse(String(opts.body)) : null;
    calls.push({ path, method: opts?.method ?? 'GET', body });
    if (path.endsWith('/merge')) return merge(body!);
    if (pr === null) throw new Error('GitHub API error: 502');
    return pr;
  });
  return { api, calls, merges: () => calls.filter((c) => c.path.endsWith('/merge')) };
}

const open = (sha: string) => ({ state: 'open', merged: false, head: { sha } });
const noKernel = async () => null;
const passGate = mock(async () => ({ blocks: false }) as never);

describe('mergeReleasePrPinned', () => {
  test('merges the verified head, pinned with GitHub\'s sha, after the review gate at that head', async () => {
    const g = github(open('verified1'));
    const gate = mock(async () => ({ blocks: false }) as never);
    const r = await mergeReleasePrPinned(input(), { api: g.api, land: noKernel, reviewGate: gate });
    expect(r).toEqual({ merged: true, sha: 'mergesha1', message: 'PR merged', via: 'pinned' });
    expect(g.merges().map((c) => c.body)).toEqual([{ merge_method: 'merge', sha: 'verified1' }]);
    expect((gate.mock.calls[0] as unknown[])[0]).toMatchObject({ prNumber: 47, headSha: 'verified1', surface: 'release compose' });
  });

  test('AC-16: a head that moved after verification is refused and nothing is merged', async () => {
    const g = github(open('pushed2'));
    const r = await mergeReleasePrPinned(input(), { api: g.api, land: noKernel, reviewGate: passGate });
    expect(r).toMatchObject({ merged: false, refused: 'head_moved', headSha: 'pushed2' });
    expect(g.merges()).toEqual([]);
  });

  test('AC-16: GitHub refusing the pinned merge because the head moved under the call is a refusal, not a merge', async () => {
    let reads = 0;
    const calls: string[] = [];
    const api = mock(async (_i: number, path: string) => {
      calls.push(path);
      if (path.endsWith('/merge')) throw new Error('GitHub API error: 409 {"message":"Head branch was modified. Review and try the merge again."}');
      return ++reads === 1 ? open('verified1') : open('pushed2');
    });
    const r = await mergeReleasePrPinned(input(), { api, land: noKernel, reviewGate: passGate });
    expect(r).toMatchObject({ merged: false, refused: 'head_moved', headSha: 'pushed2' });
  });

  test('a review verdict holding the head stops the merge', async () => {
    const g = github(open('verified1'));
    const r = await mergeReleasePrPinned(input(), { api: g.api, land: noKernel, reviewGate: async () => ({ blocks: true, reason: 'changes requested' }) as never });
    expect(r).toMatchObject({ merged: false, refused: 'review' });
    expect(r.message).toContain('changes requested');
    expect(g.merges()).toEqual([]);
  });

  test('a PR the kernel owns lands through the kernel at the verified head; buildd never merges it itself', async () => {
    const g = github(open('verified1'));
    const land = mock(async () => ({ merged: true, outcome: 'merged', reason: 'merged', message: 'Pull request merged', mergeCommitSha: 'kmerge', current: { state: 'MERGED', version: 9, head: 'verified1', round: 1 }, result: null }) as never);
    const gate = mock(async () => ({ blocks: false }) as never);
    const r = await mergeReleasePrPinned(input(), { api: g.api, land, reviewGate: gate });
    expect(r).toEqual({ merged: true, sha: 'kmerge', message: 'Pull request merged', via: 'kernel' });
    expect((land.mock.calls[0] as unknown[])[0]).toMatchObject({ headSha: 'verified1', door: 'release:release compose', prNumber: 47 });
    expect(g.merges()).toEqual([]);
    expect(gate).not.toHaveBeenCalled();
  });

  test('a kernel refusal is passed on, not merged around', async () => {
    const g = github(open('verified1'));
    const land = async () => ({ merged: false, outcome: 'rejected', reason: 'state_not_allowed', message: 'The workflow refused to land this PR (state_not_allowed); nothing was merged.', mergeCommitSha: null, current: { state: 'CHANGES_REQUESTED', version: 3, head: 'verified1', round: 1 }, result: null }) as never;
    const r = await mergeReleasePrPinned(input(), { api: g.api, land, reviewGate: passGate });
    expect(r).toMatchObject({ merged: false, refused: 'kernel' });
    expect(g.merges()).toEqual([]);
  });

  test('already merged is the answer; an unreadable PR merges nothing', async () => {
    const merged = github({ state: 'closed', merged: true, merge_commit_sha: 'm9', head: { sha: 'verified1' } });
    expect(await mergeReleasePrPinned(input(), { api: merged.api, land: noKernel, reviewGate: passGate })).toMatchObject({ merged: true, sha: 'm9', alreadyMerged: true });
    const down = github(null);
    expect(await mergeReleasePrPinned(input(), { api: down.api, land: noKernel, reviewGate: passGate })).toMatchObject({ merged: false, refused: 'unreadable' });
    expect(down.merges()).toEqual([]);
  });

  test('with no head verified by the door, the live head is the one gated and pinned (D9)', async () => {
    const g = github(open('live7'));
    const gate = mock(async () => ({ blocks: false }) as never);
    await mergeReleasePrPinned(input({ verifiedHeadSha: null, mergeMethod: 'squash' }), { api: g.api, land: noKernel, reviewGate: gate });
    expect(g.merges().map((c) => c.body)).toEqual([{ merge_method: 'squash', sha: 'live7' }]);
    expect((gate.mock.calls[0] as unknown[])[0]).toMatchObject({ headSha: 'live7' });
  });
});
