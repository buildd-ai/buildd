import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';
const realFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = realFetch; });
let workspace: any;
let repo: any;
let installation: any;
mock.module('../db/client', () => ({ db: { query: {
  workspaces: { findFirst: async () => workspace },
  githubRepos: { findFirst: async () => repo },
  githubInstallations: { findFirst: async () => installation },
} } }));
mock.module('../github-installation-auth', () => ({ getInstallationToken: async () => 'test-token' }));
const { loadTaskPrDiffs } = await import('../task-pr-diffs');
beforeEach(() => {
  workspace = { repo: 'example/project', githubRepoId: 'linked', githubInstallationId: 'installation' };
  repo = { fullName: 'example/linked' }; installation = { installationId: 1 };
});
describe('task PR diff adapter', () => {
  it('reports unavailable installation as missing data without reading GitHub', async () => {
    installation = null;
    globalThis.fetch = mock(async () => { throw new Error('unexpected fetch'); }) as typeof fetch;
    const result = await loadTaskPrDiffs('workspace', [{ taskId: 'task', prNumber: 1 }]);
    expect(result.get('task')?.[0]).toMatchObject({ status: 'incomplete', reason: 'read_failed' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses the linked repository and fans out one pinned paginated read per PR', async () => {
    const paths: string[] = [];
    globalThis.fetch = mock(async (url, init) => {
      paths.push(String(url));
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token');
      const raw = String(url).includes('/files?') ? [{ filename: 'pr.ts' }] : { state: 'closed', merged: true, head: { sha: 'head' }, base: { sha: 'base' }, changed_files: 1 };
      return new Response(JSON.stringify(raw));
    }) as typeof fetch;
    const result = await loadTaskPrDiffs('workspace', [{ taskId: 'task', prNumber: 1 }, { taskId: 'retry', prNumber: 1 }]);
    expect(result.get('task')?.[0]).toMatchObject({ status: 'complete', files: ['pr.ts'] });
    expect(result.get('retry')?.[0]).toMatchObject({ status: 'complete', files: ['pr.ts'] });
    expect(paths).toHaveLength(3);
    expect(paths.every(p => p.includes('/repos/example/linked/pulls/1'))).toBe(true);
  });
  it('records an unavailable file page instead of an empty diff', async () => {
    globalThis.fetch = mock(async url => String(url).includes('/files?') ? new Response('', { status: 403 }) : new Response(JSON.stringify({ head: { sha: 'head' }, base: { sha: 'base' }, changed_files: 1 }))) as typeof fetch;
    expect((await loadTaskPrDiffs('workspace', [{ taskId: 'task', prNumber: 1 }])).get('task')?.[0]).toMatchObject({ status: 'incomplete', reason: 'read_failed' });
  });
});
