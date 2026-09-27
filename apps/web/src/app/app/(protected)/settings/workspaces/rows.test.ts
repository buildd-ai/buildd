import { describe, expect, it } from 'bun:test';
import { buildWorkspaceRows, moveTargets } from './rows';

// Illustrative fixtures only.
const USER = 'user-1';
const team = (id: string, role: string, slug = id) => ({ id, name: `Name ${id}`, slug, role, memberCount: 1 });

describe('buildWorkspaceRows', () => {
  it('labels the git workflow and merge policy from gitConfig, with the server defaults', () => {
    const { rows } = buildWorkspaceRows({
      userId: USER,
      teams: [team('t1', 'owner')],
      workspaces: [
        { id: 'w1', name: 'a', teamId: 't1', gitConfig: null },
        { id: 'w2', name: 'b', teamId: 't1', gitConfig: { branchStrategy: 'direct', mergePolicy: { tier: 'human' }, enforceGreenCI: true } as never },
      ],
    });
    expect(rows.map((r) => [r.gitWorkflow, r.mergePolicy, r.enforceGreenCI])).toEqual([
      ['Mission branch', 'Auto-threshold', false],
      ['Direct', 'Human gate', true],
    ]);
  });

  it('allows a move only when the user administers the workspace team and at least one other team', () => {
    const { rows, moveTeams } = buildWorkspaceRows({
      userId: USER,
      teams: [team('t1', 'owner'), team('t2', 'admin'), team('t3', 'member')],
      workspaces: [
        { id: 'w1', name: 'a', teamId: 't1', gitConfig: null },
        { id: 'w3', name: 'c', teamId: 't3', gitConfig: null },
      ],
    });
    expect(rows.map((r) => [r.id, r.canMove, r.canEdit])).toEqual([['w1', true, true], ['w3', false, false]]);
    expect(moveTeams.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('counts the personal team as administered, and no move with a single admin team', () => {
    const { rows } = buildWorkspaceRows({
      userId: USER,
      teams: [team('p', 'member', `personal-${USER}`), team('t3', 'member')],
      workspaces: [{ id: 'w1', name: 'a', teamId: 'p', gitConfig: null }],
    });
    expect(rows[0]).toMatchObject({ canEdit: true, canMove: false });
  });
});

describe('moveTargets', () => {
  it('returns the administered teams when the workspace can move, else null', () => {
    const teams = [team('t1', 'owner'), team('t2', 'admin'), team('t3', 'member')];
    expect(moveTargets(USER, teams, 't1')?.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(moveTargets(USER, teams, 't3')).toBeNull();
    expect(moveTargets(USER, [team('t1', 'owner'), team('t3', 'member')], 't1')).toBeNull();
  });
});
