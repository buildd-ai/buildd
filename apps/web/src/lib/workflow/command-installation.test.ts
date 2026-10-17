/**
 * Which installation a kernel command acts through (command-installation.ts): derived from the
 * repo it names, the same way the doors derive the one they send.
 */
import { describe, expect, it } from 'bun:test';
import { expectedInstallation, type InstallationLookups } from './command-installation';

const WS = '11111111-1111-4111-8111-111111111111';

function lookups(o: { ws?: { fullName: string | null; installationId: number | null }; repos?: Record<string, number>; scope?: string[] } = {}) {
  const asked: string[] = [];
  const l: InstallationLookups = {
    workspace: async () => o.ws ?? { fullName: 'acme/w', installationId: 1 },
    forRepo: async (r) => o.repos?.[r] ?? null,
    inScope: async (_ws, r) => { asked.push(r); return (o.scope ?? []).includes(r); },
  };
  return { l, asked };
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
});
