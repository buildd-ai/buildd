/**
 * Review by risk R-6 at the held-release door: a green release PR waits on the
 * release-summary check, reached through its `@/modules` hook.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

const HEAD = 'a'.repeat(40);
let gate: (q: { headSha: string; door: string }) => Promise<unknown>;
let kernelAsked = 0;

const realGithub = await import('@/lib/github');
const realAuthority = await import('@/lib/workflow/authority');
mock.module('@buildd/core/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 't1', workspaceId: 'w1', context: {} }] }) }) }) },
}));
mock.module('@/lib/github', () => ({
  ...realGithub,
  githubApi: async () => ({ head: { sha: HEAD } }),
  allCheckSuitesPassed: async () => true,
  mergePullRequest: async () => { throw new Error('must not merge in this test'); },
}));
mock.module('@/modules', () => ({ SUBSCRIBERS: [], RELEASE_SUMMARY_GATE: (q: { headSha: string; door: string }) => gate(q) }));
mock.module('@/lib/workflow/authority', () => ({
  ...realAuthority,
  kernelDeliveryForPr: async () => { kernelAsked++; throw new Error('stop after the summary check'); },
}));

const { handleReleasePrCiSuccess } = await import('./held-pr-tasks');
const land = () => handleReleasePrCiSuccess(7, 1, 'o/r', HEAD, { repoFor: (async () => ({ repoFullName: 'o/r' })) as never }).catch(() => undefined);

describe('held release and the release summary', () => {
  beforeEach(() => { kernelAsked = 0; });

  it('R-6: an unapproved summary stops the merge of exactly this commit', async () => {
    const seen: unknown[] = [];
    gate = async (q) => { seen.push(q); return { blocks: true, reason: 'waits', clearedBy: 'approve it' }; };
    await land();
    expect(seen).toEqual([expect.objectContaining({ headSha: HEAD, door: 'merge' })]);
    expect(kernelAsked).toBe(0);
  });

  it('an approved summary lets the release go on', async () => {
    gate = async () => ({ blocks: false });
    await land();
    expect(kernelAsked).toBe(1);
  });

  it('a check that cannot run does not fail the release', async () => {
    gate = async () => { throw new Error('no module'); };
    await land();
    expect(kernelAsked).toBe(1);
  });
});
