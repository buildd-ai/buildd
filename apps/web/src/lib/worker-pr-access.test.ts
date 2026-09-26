import { describe, it, expect } from 'bun:test';
import { canActOnWorkerPr } from './worker-pr-access';

const ownTeam = { id: 'acct-user', teamId: 'team-a' };
const runner = { id: 'acct-runner', teamId: 'team-runner' };
const worker = (accountId: string | null) => ({ accountId, workspaceId: 'ws-1', workspace: { id: 'ws-1', teamId: 'team-a' } });
const grants = (...g: Array<{ workspaceId: string; canClaim: boolean }>) => async () => g.map(x => ({ ...x, canCreate: false }));

describe('canActOnWorkerPr', () => {
  it('allows a caller whose team owns the workspace', async () => {
    expect(await canActOnWorkerPr(ownTeam, worker('acct-runner'), grants())).toBe(true);
  });

  it('allows the cross-team account running the worker while it holds a claim grant', async () => {
    expect(await canActOnWorkerPr(runner, worker('acct-runner'), grants({ workspaceId: 'ws-1', canClaim: true }))).toBe(true);
  });

  it('refuses the running account once its claim grant is gone or revoked', async () => {
    expect(await canActOnWorkerPr(runner, worker('acct-runner'), grants())).toBe(false);
    expect(await canActOnWorkerPr(runner, worker('acct-runner'), grants({ workspaceId: 'ws-1', canClaim: false }))).toBe(false);
    expect(await canActOnWorkerPr(runner, worker('acct-runner'), grants({ workspaceId: 'ws-other', canClaim: true }))).toBe(false);
  });

  it('refuses a granted cross-team account that does not run the worker', async () => {
    expect(await canActOnWorkerPr(runner, worker('acct-other'), grants({ workspaceId: 'ws-1', canClaim: true }))).toBe(false);
  });

  it('never matches on nulls', async () => {
    expect(await canActOnWorkerPr({ id: 'x', teamId: null }, { accountId: null, workspace: { teamId: null } }, grants())).toBe(false);
  });
});
