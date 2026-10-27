/**
 * list_workspaces never shows a team without a name. GET /api/workspaces
 * sends a workspace's team name as `teamName`; the listing used to read only
 * `team.name`, so every team came out `teamName: null` on API-key and older
 * OAuth transports. A team whose stored name is blank reads
 * "Unnamed team <first 8 of its id>".
 */
import { describe, expect, it, mock } from 'bun:test';
import { displayTeamName } from '@buildd/shared';
import { handleBuilddAction, renderWorkspaceListing, type ApiFn } from '../mcp-tools';

const ctx = { workspaceId: 'ws', getWorkspaceId: async () => 'ws', getLevel: async () => 'worker' } as never;

describe('list_workspaces team names', () => {
  it('reads the team name GET /api/workspaces sends', async () => {
    const api = mock(async () => ({
      workspaces: [
        { id: 'w1', name: 'api', repo: 'acme/api', teamId: 't1', teamName: 'Acme' },
        { id: 'w2', name: 'web', repo: null, teamId: 't1', team: { name: 'Acme' } },
      ],
    }));
    const res = await handleBuilddAction(api as unknown as ApiFn, 'list_workspaces', {}, ctx);
    const out = JSON.parse(res.content[0].text);
    expect(out.teams).toEqual([expect.objectContaining({ teamId: 't1', teamName: 'Acme' })]);
    expect(out.teams[0].workspaces.map((w: { id: string }) => w.id)).toEqual(['w1', 'w2']);
  });

  it('a blank or missing name reads as a distinguishable unnamed team, never empty', () => {
    const out = JSON.parse(renderWorkspaceListing([
      { workspaceId: 'w1', name: 'api', teamId: 'aaaaaaaa-0000-4000-8000-000000000001', teamName: '  ' },
      { workspaceId: 'w2', name: 'web', teamId: 'bbbbbbbb-0000-4000-8000-000000000002', teamName: null },
    ], {}));
    expect(out.teams.map((t: { teamName: string }) => t.teamName)).toEqual(['Unnamed team aaaaaaaa', 'Unnamed team bbbbbbbb']);
  });

  it('displayTeamName keeps a real name and never returns an empty string', () => {
    expect(displayTeamName(' Acme ', 'x')).toBe('Acme');
    expect(displayTeamName('', null)).toBe('Unnamed team');
    expect(displayTeamName(undefined, '12345678-aaaa')).toBe('Unnamed team 12345678');
  });
});
