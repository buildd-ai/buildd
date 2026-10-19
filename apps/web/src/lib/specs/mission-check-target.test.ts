import { beforeEach, describe, expect, it, mock } from 'bun:test';
const SHA = 'a'.repeat(40);
let integration = true;
let ancestor = true;
let requested: string[];
mock.module('@buildd/core/db', () => ({ db: {
  query: {
    missions: { findFirst: async () => ({ id: 'm', workspaceId: 'ws', integrationBranchEnabled: integration, workingBranch: 'mission/x' }) },
    workspaces: { findFirst: async () => ({ githubRepoId: 'repo', gitConfig: { targetBranch: 'dev' } }) },
    githubRepos: { findFirst: async () => ({ fullName: 'example/app', defaultBranch: 'main', installation: { installationId: 1 } }) },
  },
  select: () => ({ from: () => ({ where: async () => [{ id: 'task', taskClass: 'work', kind: 'engineering', title: 'Build', mode: 'execution', creationSource: 'user' }] }) }),
} }));
mock.module('@/lib/mission-repo-workspace', () => ({ resolveMissionRepoWorkspaceId: async () => ({ workspaceId: 'ws' }) }));
mock.module('@/lib/workflow/delivery-view', () => ({ mergedDeliveryCommits: async () => [{ mergeCommitSha: 'b'.repeat(40) }] }));
mock.module('@/lib/integration-refresh', () => ({ encodeRef: (s: string) => s, isAncestor: async () => ancestor }));
mock.module('@/lib/github', () => ({ githubApi: async () => null }));
const { resolveMissionCheckTarget } = await import('./mission-outcome');
const api = async (_id: number, path: string) => { requested.push(path); return { object: { sha: SHA } }; };
beforeEach(() => { requested = []; integration = true; ancestor = true; });
describe('mechanical checks target the merged result', () => {
  it('pins the integration branch head', async () => {
    expect(await resolveMissionCheckTarget('m', api)).toEqual({ headSha: SHA, branch: 'mission/x' });
  });
  it('uses configured trunk only when it contains all mission merges', async () => {
    integration = false;
    expect(await resolveMissionCheckTarget('m', api)).toEqual({ headSha: SHA, branch: 'dev' });
    expect(requested.some((p) => p.endsWith('heads/dev'))).toBe(true);
    ancestor = false;
    expect(await resolveMissionCheckTarget('m', api)).toBeNull();
  });
  it('does not invent a target when GitHub is unavailable', async () => {
    expect(await resolveMissionCheckTarget('m', async () => { throw new Error('unavailable'); })).toBeNull();
  });
});
