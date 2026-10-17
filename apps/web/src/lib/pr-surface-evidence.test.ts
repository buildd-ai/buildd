import { beforeEach, expect, it, mock } from 'bun:test';

const rows = new Map<string, any>();
let failDb = false;
let head = 'a';
let merged = false;
const UI = 'apps/web/src/components/Card.tsx';
let files: any[] = [];
const githubApi = mock(async (_id: number, path: string): Promise<any> =>
  path.includes('/files?') ? files : { head: { sha: head }, merged });
mock.module('@/lib/github', () => ({ githubApi }));
mock.module('@buildd/core/db', () => ({ db: {
  query: { systemCache: { findFirst: async ({ where }: any) => {
    if (failDb) throw new Error('cache unavailable');
    return rows.get(where);
  } } },
  insert: () => ({ values: (row: any) => ({ onConflictDoUpdate: async () => { rows.set(row.key, row); } }) }),
} }));
mock.module('@buildd/core/db/relational-sql', () => ({ sqlWhere: (x: any) => x }));
mock.module('@buildd/core/db/schema', () => ({ systemCache: { key: 'key' } }));
mock.module('drizzle-orm', () => ({ eq: (_a: any, b: any) => b }));
const { loadPrSurfaceFiles, persistMergedSurfaceEvidence } = await import('./pr-surface-evidence');
const repo = { installationId: 7, fullName: 'acme/app' };
const fileCalls = () => githubApi.mock.calls.filter(c => c[1].includes('/files?')).length;
beforeEach(() => { rows.clear(); failDb = false; head = 'a'; merged = false; files = []; githubApi.mockClear(); });

it('caches unchanged authoritative open heads, including empty evidence', async () => {
  expect(await loadPrSurfaceFiles(repo, 1)).toEqual([]);
  expect(await loadPrSurfaceFiles(repo, 1)).toEqual([]);
  expect(fileCalls()).toBe(1);
  head = 'b'; files = [{ filename: UI, patch: '+<div />' }];
  expect(await loadPrSurfaceFiles(repo, 1)).toEqual([{ path: UI, patch: '+<div />' }]);
  expect(fileCalls()).toBe(2);
});
it('never reads merged file lists on a cold cache, expired cache or cache failure', async () => {
  merged = true;
  expect(await loadPrSurfaceFiles(repo, 1)).toBeNull();
  for (const row of rows.values()) row.expiresAt = new Date(0);
  expect(await loadPrSurfaceFiles(repo, 1, true)).toBeNull();
  failDb = true;
  expect(await loadPrSurfaceFiles(repo, 1, true)).toBeNull();
  expect(fileCalls()).toBe(0);
});
it('stores merged patches durably outside rendering and reads them without GitHub', async () => {
  merged = true; files = [{ filename: UI, patch: '+// comment' }];
  await persistMergedSurfaceEvidence(repo, 1);
  expect(fileCalls()).toBe(1);
  githubApi.mockClear();
  expect(await loadPrSurfaceFiles(repo, 1, true)).toEqual([{ path: UI, patch: '+// comment' }]);
  expect(githubApi).not.toHaveBeenCalled();
  expect([...rows.values()].every(r => r.expiresAt == null)).toBe(true);
});
it('does not cache a file list against a head that moved during the read', async () => {
  githubApi.mockImplementationOnce(async () => ({ head: { sha: 'a' }, merged: false }));
  head = 'b'; files = [{ filename: UI }];
  expect(await loadPrSurfaceFiles(repo, 1)).toBeNull();
  expect(rows.size).toBe(0);
});
it('rejects truncated evidence rather than proving no UI change', async () => {
  files = Array.from({ length: 100 }, () => ({ filename: 'server.ts' }));
  expect(await loadPrSurfaceFiles(repo, 1)).toBeNull();
  expect(rows.size).toBe(0);
});
