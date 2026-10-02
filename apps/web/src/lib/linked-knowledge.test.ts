import { describe, it, expect, beforeEach, mock } from 'bun:test';

type Row = { id: string; teamId: string; accessMode: string; dataClass: string; gitConfig?: any };

let source: Row | undefined;
let targets: Row[] = [];
let links: Array<{ workspaceId: string; canClaim: boolean; canCreate: boolean }> = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: {
        findFirst: async () => source,
        // Returns every row regardless of the where clause: the resolver must
        // not rely on the query alone to enforce team and sensitivity.
        findMany: async () => targets,
      },
    },
  },
}));
mock.module('@/lib/account-workspace-cache', () => ({
  getAccountWorkspacePermissions: async () => links,
}));

const { resolveLinkedDocsWorkspaces } = await import('./linked-knowledge');

const SRC = 'src-ws';
const KB = 'kb-ws';
const KB2 = 'kb2-ws';
const account = (over: Partial<{ id: string; teamId: string; workspaceIds: string[] | null }> = {}) =>
  ({ id: 'acct-1', teamId: 'team-a', workspaceIds: null, ...over });
const target = (id: string, over: Partial<Row> = {}): Row =>
  ({ id, teamId: 'team-a', accessMode: 'open', dataClass: 'standard', ...over });

beforeEach(() => {
  source = { id: SRC, teamId: 'team-a', accessMode: 'open', dataClass: 'standard', gitConfig: { linkedKnowledgeWorkspaces: [KB] } };
  targets = [target(KB)];
  links = [];
});

describe('resolveLinkedDocsWorkspaces', () => {
  it('returns a linked same-team open workspace', async () => {
    expect(await resolveLinkedDocsWorkspaces({ workspaceId: SRC, account: account() })).toEqual([KB]);
  });

  it('returns nothing when the workspace has no links configured', async () => {
    source = { ...source!, gitConfig: {} };
    expect(await resolveLinkedDocsWorkspaces({ workspaceId: SRC, account: account() })).toEqual([]);
    source = { ...source!, gitConfig: null };
    expect(await resolveLinkedDocsWorkspaces({ workspaceId: SRC, account: account() })).toEqual([]);
  });

  it('returns nothing for an unknown source workspace or no workspace id', async () => {
    source = undefined;
    expect(await resolveLinkedDocsWorkspaces({ workspaceId: SRC, account: account() })).toEqual([]);
    expect(await resolveLinkedDocsWorkspaces({ workspaceId: null, account: account() })).toEqual([]);
  });

  it('fails closed without a caller account', async () => {
    expect(await resolveLinkedDocsWorkspaces({ workspaceId: SRC, account: null })).toEqual([]);
  });

  it('an unlinked workspace is never returned', async () => {
    targets = [target(KB), target(KB2)];
    expect(await resolveLinkedDocsWorkspaces({ workspaceId: SRC, account: account() })).toEqual([KB]);
  });

  it('a different team never leaks, even if linked in config', async () => {
    targets = [target(KB, { teamId: 'team-b' })];
    expect(await resolveLinkedDocsWorkspaces({ workspaceId: SRC, account: account() })).toEqual([]);
    // ...and not even for an account of that other team that is explicitly linked
    links = [{ workspaceId: KB, canClaim: true, canCreate: true }];
    expect(await resolveLinkedDocsWorkspaces({ workspaceId: SRC, account: account({ teamId: 'team-b' }) })).toEqual([]);
  });

  it('a sensitive target is never returned', async () => {
    targets = [target(KB, { dataClass: 'sensitive' })];
    expect(await resolveLinkedDocsWorkspaces({ workspaceId: SRC, account: account() })).toEqual([]);
  });

  it('a restricted target needs an explicit account link', async () => {
    targets = [target(KB, { accessMode: 'restricted' })];
    expect(await resolveLinkedDocsWorkspaces({ workspaceId: SRC, account: account() })).toEqual([]);
    links = [{ workspaceId: KB, canClaim: false, canCreate: false }];
    expect(await resolveLinkedDocsWorkspaces({ workspaceId: SRC, account: account() })).toEqual([KB]);
  });

  it('a person session reaches a restricted same-team workspace without an account link', async () => {
    targets = [target(KB, { accessMode: 'restricted' })];
    expect(await resolveLinkedDocsWorkspaces({ workspaceId: SRC, account: { ...account(), sessionUser: true } })).toEqual([KB]);
    // ...but still never across teams or into a sensitive workspace
    targets = [target(KB, { teamId: 'team-b' }), target(KB2, { dataClass: 'sensitive' })];
    source = { ...source!, gitConfig: { linkedKnowledgeWorkspaces: [KB, KB2] } };
    expect(await resolveLinkedDocsWorkspaces({ workspaceId: SRC, account: { ...account(), sessionUser: true } })).toEqual([]);
  });

  it('a workspace-restricted token reads a linked workspace only if it is on its list', async () => {
    expect(await resolveLinkedDocsWorkspaces({ workspaceId: SRC, account: account({ workspaceIds: [SRC] }) })).toEqual([]);
    expect(await resolveLinkedDocsWorkspaces({ workspaceId: SRC, account: account({ workspaceIds: [SRC, KB] }) })).toEqual([KB]);
  });

  it('ignores itself, non-strings and duplicates in the config', async () => {
    source = { ...source!, gitConfig: { linkedKnowledgeWorkspaces: [SRC, KB, KB, 7, null, ''] } };
    targets = [target(KB), target(SRC)];
    expect(await resolveLinkedDocsWorkspaces({ workspaceId: SRC, account: account() })).toEqual([KB]);
  });

  it('fails closed when the lookup throws', async () => {
    links = null as any;
    targets = [target(KB, { accessMode: 'restricted' })];
    expect(await resolveLinkedDocsWorkspaces({ workspaceId: SRC, account: account() })).toEqual([]);
  });
});
