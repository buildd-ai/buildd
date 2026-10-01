/**
 * getWorkspaceConfig must not turn an auth refusal into "unconfigured".
 *
 * A run that cannot read its workspace config loses the git config, agent
 * instructions, PR target and budget cap. Treating a 401/403 as "no config"
 * made that silent; it must fail the run instead. A transport fault or a 5xx
 * still degrades to unconfigured, as before.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/buildd-workspace-config-auth.test.ts
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { BuilddClient } from '../../src/buildd';
import type { LocalUIConfig } from '../../src/types';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function client() {
  return new BuilddClient({
    projectsRoot: '/tmp',
    builddServer: 'http://server.invalid',
    apiKey: 'test-key',
    maxConcurrent: 1,
  } as LocalUIConfig);
}

function respondWith(status: number, body: string) {
  globalThis.fetch = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  })) as any;
}

describe('getWorkspaceConfig', () => {
  test('401 fails loudly', async () => {
    respondWith(401, '{"error":"Unauthorized"}');
    await expect(client().getWorkspaceConfig('ws-1')).rejects.toThrow(/workspace config/i);
  });

  test('403 fails loudly', async () => {
    respondWith(403, '{"error":"Forbidden"}');
    await expect(client().getWorkspaceConfig('ws-1')).rejects.toThrow(/workspace config/i);
  });

  test('404 and 500 still degrade to unconfigured', async () => {
    respondWith(404, '{"error":"Workspace not found"}');
    expect(await client().getWorkspaceConfig('ws-1')).toEqual({ configStatus: 'unconfigured' });
    respondWith(500, 'boom');
    expect(await client().getWorkspaceConfig('ws-1')).toEqual({ configStatus: 'unconfigured' });
  });

  test('a config body passes through', async () => {
    respondWith(200, '{"configStatus":"admin_confirmed","gitConfig":{"defaultBranch":"main"}}');
    expect((await client().getWorkspaceConfig('ws-1')).configStatus).toBe('admin_confirmed');
  });
});
