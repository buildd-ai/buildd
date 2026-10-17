/**
 * Which installation a kernel command acts through (command-installation.ts): derived from the
 * repo it names, the same way the doors derive the one they send.
 */
import { describe, expect, it } from 'bun:test';
import { expectedInstallation, type InstallationLookups } from './command-installation';

const WS = '11111111-1111-4111-8111-111111111111';

const TEAM = '22222222-2222-4222-8222-222222222222';

function lookups(o: {
  ws?: { fullName: string | null; installationId: number | null; teamId?: string | null };
  repos?: Record<string, number>;
  scope?: string[];
  /** Installations of the team; every one by default. */
  teamOwns?: number[];
} = {}) {
  const asked: string[] = [];
  const ownership: number[] = [];
  const l: InstallationLookups = {
    workspace: async () => ({ teamId: TEAM, ...(o.ws ?? { fullName: 'acme/w', installationId: 1 }) }),
    forRepo: async (r) => o.repos?.[r] ?? null,
    inScope: async (_ws, r) => { asked.push(r); return (o.scope ?? []).includes(r); },
    ownedByTeam: async (id, team) => { ownership.push(id); return team === TEAM && (o.teamOwns ? o.teamOwns.includes(id) : true); },
  };
  return { l, asked, ownership };
}

describe('expectedInstallation', () => {
  it('the workspace\'s own repo: its installation, without reading scope (any casing)', async () => {
    const { l, asked } = lookups({ repos: { 'acme/w': 1 } });
    expect(await expectedInstallation(WS, 'Acme/W', l)).toEqual({ installationId: 1 });
    expect(asked).toEqual([]);
  });

  it('a cross-repo PR in scope under a second installation: that installation', async () => {
    const { l } = lookups({ repos: { 'other/mobile': 2 }, scope: ['other/mobile'] });
    expect(await expectedInstallation(WS, 'other/mobile', l)).toEqual({ installationId: 2 });
  });

  it('a repo outside the workspace\'s and its missions\' scope is refused', async () => {
    const { l } = lookups({ repos: { 'someone/else': 3 } });
    expect(await expectedInstallation(WS, 'someone/else', l)).toEqual({ refused: 'repo_out_of_scope' });
  });

  it('a workspace with no linked repo resolves a cross-repo command through the PR\'s repo', async () => {
    const { l } = lookups({ ws: { fullName: null, installationId: null }, repos: { 'acme/app': 5 }, scope: ['acme/app'] });
    expect(await expectedInstallation(WS, 'acme/app', l)).toEqual({ installationId: 5 });
  });

  it('a repo in scope with no installation row of its own falls back to the workspace\'s, as the doors do', async () => {
    const { l } = lookups({ scope: ['acme/sibling'] });
    expect(await expectedInstallation(WS, 'acme/sibling', l)).toEqual({ installationId: 1 });
  });

  it('nothing covers the repo: no_installation', async () => {
    const { l } = lookups({ ws: { fullName: 'acme/w', installationId: null } });
    expect(await expectedInstallation(WS, 'acme/w', l)).toEqual({ refused: 'no_installation' });
  });

  it('the workspace\'s own linked installation is used without an ownership read', async () => {
    const { l, ownership } = lookups({ repos: { 'acme/w': 1 }, teamOwns: [] });
    expect(await expectedInstallation(WS, 'acme/w', l)).toEqual({ installationId: 1 });
    expect(ownership).toEqual([]);
  });

  it('a cross-repo PR in scope under another of the team\'s installations is accepted', async () => {
    const { l, ownership } = lookups({ repos: { 'other/mobile': 2 }, scope: ['other/mobile'], teamOwns: [2] });
    expect(await expectedInstallation(WS, 'other/mobile', l)).toEqual({ installationId: 2 });
    expect(ownership).toEqual([2]);
  });

  it('a repo in scope whose installation belongs to another team is refused', async () => {
    const { l } = lookups({ repos: { 'other/mobile': 2 }, scope: ['other/mobile'], teamOwns: [] });
    expect(await expectedInstallation(WS, 'other/mobile', l)).toEqual({ refused: 'installation_not_team_owned' });
  });

  it('a workspace with no linked installation is refused an installation its team does not own, even for its own repo', async () => {
    const { l } = lookups({ ws: { fullName: 'acme/w', installationId: null }, repos: { 'acme/w': 7 }, teamOwns: [] });
    expect(await expectedInstallation(WS, 'acme/w', l)).toEqual({ refused: 'installation_not_team_owned' });
  });
});
