/**
 * The gated release baseline's rung 4 (no release row yet: the prod branch's
 * head) asks GitHub. A page render never does (spec 3ef37387 R-12): it reads
 * the last answer from system_cache, and a missing or old one is refreshed
 * after the response.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

let releaseRows: unknown[] = [];
let cacheRow: { value: unknown; expiresAt: Date | null } | undefined;
const writes: Array<{ key: string; value: unknown }> = [];

mock.module('@buildd/core/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => releaseRows }) }),
    query: { systemCache: { findFirst: async () => cacheRow } },
    insert: () => ({
      values: (v: { key: string; value: unknown }) => ({
        onConflictDoUpdate: async () => { writes.push({ key: v.key, value: v.value }); },
      }),
    }),
  },
}));

const deferred: Array<() => unknown> = [];
const nextServer = await import('next/server');
mock.module('next/server', () => ({ ...nextServer, after: (fn: () => unknown) => { deferred.push(fn); } }));

const githubCalls: string[] = [];
const realGithub = await import('@/lib/github');
mock.module('@/lib/github', () => ({
  ...realGithub,
  isGitHubAppConfigured: () => true,
  githubApi: async (_i: number, path: string) => {
    githubCalls.push(path);
    return { commit: { committer: { date: '2026-09-01T00:00:00Z' } } };
  },
}));
mock.module('@/lib/release/target', () => ({
  resolveReleaseTarget: async () => ({ ok: true, target: { installationId: 1, owner: 'example', name: 'repo', defaultBranch: 'dev', releaseConfig: { prodBranch: 'main' } } }),
}));

const { resolveGatedReleaseBaseline } = await import('./release-baseline');

beforeEach(() => {
  releaseRows = [];
  cacheRow = undefined;
  writes.length = 0;
  deferred.length = 0;
  githubCalls.length = 0;
});

describe('resolveGatedReleaseBaseline on a render', () => {
  it('with no cached head: no GitHub call, no baseline yet, and a refresh after the response', async () => {
    const b = await resolveGatedReleaseBaseline('ws-1', { render: true });
    expect(githubCalls).toEqual([]);
    expect(b.asOf).toBeNull();
    expect(deferred).toHaveLength(1);

    await deferred[0]();
    expect(githubCalls).toEqual(['/repos/example/repo/commits/main']);
    expect(writes).toEqual([{ key: 'release-baseline:prod-head:v1:ws-1', value: { asOf: '2026-09-01T00:00:00Z' } }]);
  });

  it('with a fresh cached head: uses it, and nothing is refreshed', async () => {
    cacheRow = { value: { asOf: '2026-08-01T00:00:00Z' }, expiresAt: new Date(Date.now() + 60_000) };
    const b = await resolveGatedReleaseBaseline('ws-1', { render: true });
    expect(b.asOf).toBe('2026-08-01T00:00:00Z');
    expect(githubCalls).toEqual([]);
    expect(deferred).toEqual([]);
  });

  it('with an old cached head: uses it now, refreshes it after', async () => {
    cacheRow = { value: { asOf: '2026-08-01T00:00:00Z' }, expiresAt: new Date(Date.now() - 1) };
    const b = await resolveGatedReleaseBaseline('ws-1', { render: true });
    expect(b.asOf).toBe('2026-08-01T00:00:00Z');
    expect(githubCalls).toEqual([]);
    expect(deferred).toHaveLength(1);
  });

  it('outside a render it asks GitHub as before', async () => {
    const b = await resolveGatedReleaseBaseline('ws-1');
    expect(githubCalls).toHaveLength(1);
    expect(b.asOf).toBe('2026-09-01T00:00:00Z');
  });
});
