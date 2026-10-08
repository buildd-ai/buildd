import { describe, it, expect, mock } from 'bun:test';

const calls: any[] = [];
let applyImpl: () => Promise<any> = async () => ({ installed: ['vercel'], failed: [] });
mock.module('@/lib/connector-catalog-store', () => ({ loadTeamCatalog: async (teamId: string) => [{ slug: 'vercel', policy: 'preinstalled', teamId }] }));
mock.module('@/lib/connector-provision', () => ({
  applyPreinstalledToWorkspace: async (...a: any[]) => { calls.push(a); return applyImpl(); },
}));
mock.module('@buildd/core/report-ops', () => ({ reportOps: mock(async () => {}) }));
mock.module('@/modules', () => ({ SUBSCRIBERS: [] }));

const { emit } = await import('./core-emit');
const { connectorCatalogSubscribers } = await import('./connector-catalog-subscribers');

describe('workspace.created → catalog preinstall', () => {
  it('applies the team\'s catalog to the new workspace', async () => {
    await emit({ type: 'workspace.created', workspaceId: 'ws-1', teamId: 't1', origin: 'https://buildd.dev' }, { subscribers: connectorCatalogSubscribers });
    expect(calls[0]).toEqual(['t1', 'ws-1', 'https://buildd.dev', [{ slug: 'vercel', policy: 'preinstalled', teamId: 't1' }]]);
  });

  it('a failure never escapes into the creating request', async () => {
    applyImpl = async () => { throw new Error('boom'); };
    const orig = console.error;
    console.error = () => {};
    try {
      await expect(emit({ type: 'workspace.created', workspaceId: 'ws-2', teamId: 't1', origin: 'o' }, { subscribers: connectorCatalogSubscribers })).resolves.toBeUndefined();
    } finally { console.error = orig; }
  });
});
