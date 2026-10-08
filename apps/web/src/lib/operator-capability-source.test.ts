import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';

let workspace: { teamId: string } | undefined;
let rows: Array<{ workspaceId: string | null; enabled: boolean | null; metadata: unknown }> = [];
let reads = 0;
let fail = false;

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: async () => { reads++; if (fail) throw new Error('db down'); return workspace; } },
      workspaceSkills: { findMany: async () => { reads++; return rows; } },
    },
  },
}));

const { loadOperatorGrant } = await import('./operator-capability-source');
const { authorizeAgent } = await import('./operator-capability');

const scope = { providers: ['cloudflare'], projects: ['model-policy'], environments: ['production'], credentialRefs: ['cloudflare-prod'] };
const target = { provider: 'cloudflare', project: 'model-policy', environment: 'production', credentialRef: 'cloudflare-prod' };

beforeEach(() => {
  workspace = { teamId: 'team-1' };
  rows = [];
  reads = 0;
  fail = false;
});

describe('loadOperatorGrant', () => {
  it('passes the team default and the workspace override to the resolver', async () => {
    rows = [
      { workspaceId: null, enabled: true, metadata: { operator: { scope: { environments: ['production'] } } } },
      { workspaceId: 'ws-1', enabled: true, metadata: { operator: { enabled: true, scope: { ...scope, environments: ['staging', 'production'] } } } },
    ];
    const g = await loadOperatorGrant('ws-1', 'operator');
    expect(g.enabled).toBe(true);
    expect(g.scope.environments).toEqual(['production']);
    expect(authorizeAgent(g, 'deployment_secrets:use', target)).toEqual({ allowed: true });
  });

  it('a team default alone does not enable the workspace', async () => {
    rows = [{ workspaceId: null, enabled: true, metadata: { operator: { enabled: true, scope } } }];
    expect((await loadOperatorGrant('ws-1', 'operator')).enabled).toBe(false);
  });

  it('never reads the db for a role that can hold nothing', async () => {
    const g = await loadOperatorGrant('ws-1', 'builder');
    expect(reads).toBe(0);
    expect(g).toMatchObject({ enabled: false, capabilities: [] });
  });

  it('denies on an unknown workspace or a failed read, never throws', async () => {
    workspace = undefined;
    expect((await loadOperatorGrant('ws-x', 'operator')).enabled).toBe(false);
    fail = true;
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    expect((await loadOperatorGrant('ws-1', 'operator')).enabled).toBe(false);
    warn.mockRestore();
  });
});
