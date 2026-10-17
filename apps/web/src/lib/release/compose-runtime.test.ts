/**
 * D10, release compose (workflow-kernel-library.md §4): the candidate merges
 * only at the SHA it was verified on, through the release doors' pinned merge,
 * and a lost GitHub answer stays pending (indeterminate), never "refused".
 */
import { describe, expect, mock, test } from 'bun:test';

const pinned = mock(async (_p: any): Promise<any> => ({ merged: true, sha: 'm1', message: 'PR merged', via: 'pinned' }));
mock.module('./pinned-merge', () => ({ mergeReleasePrPinned: pinned }));
const { composeActionDeps } = await import('./compose-runtime');

const target = { workspaceId: 'ws-1', workspaceName: 'w', owner: 'o', name: 'r', repoFullName: 'o/r', installationId: 9, releaseConfig: null, defaultBranch: 'dev', gitConfig: null };

describe('composeActionDeps.mergePr', () => {
  test('merges the candidate through the pinned merge, at the candidate SHA', async () => {
    const r = await composeActionDeps(target as never, 'https://buildd.dev').mergePr(9, 'o/r', 47, 'merge', 'cand123', 'user-1');
    expect(r).toEqual({ merged: true, message: 'PR merged' });
    expect(pinned.mock.calls.at(-1)?.[0]).toMatchObject({ workspaceId: 'ws-1', prNumber: 47, verifiedHeadSha: 'cand123', mergeMethod: 'merge', surface: 'release compose', actorUserId: 'user-1' });
  });

  test('a lost answer is indeterminate (pending), a refusal is not', async () => {
    pinned.mockResolvedValueOnce({ merged: false, refused: 'merge_failed', indeterminate: true, message: 'socket hang up' });
    expect(await composeActionDeps(target as never, 'https://buildd.dev').mergePr(9, 'o/r', 47, 'merge', 'cand123', 'user-1')).toEqual({ merged: false, message: 'socket hang up', indeterminate: true });
    pinned.mockResolvedValueOnce({ merged: false, refused: 'head_moved', message: 'moved' });
    expect(await composeActionDeps(target as never, 'https://buildd.dev').mergePr(9, 'o/r', 47, 'merge', 'cand123', 'user-1')).toEqual({ merged: false, message: 'moved' });
  });
});
