import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
  getLatestVersion,
  resolveVersionBranch,
  DEFAULT_VERSION_BRANCH,
  __resetVersionCacheForTests,
  __ageVersionCacheForTests,
} from './version-cache';

const realFetch = globalThis.fetch;
let requested: string[] = [];

function installFetch() {
  requested = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/tags')) {
      return new Response(JSON.stringify([{ name: 'v9.9.9' }]), { status: 200 });
    }
    // Echo the ref back as the sha so a test can prove WHICH ref was resolved.
    const ref = url.split('/commits/')[1] ?? 'unknown';
    return new Response(JSON.stringify({ sha: `sha-for-${ref}` }), { status: 200 });
  }) as typeof fetch;
}

function commitRequests(): string[] {
  return requested.filter(u => u.includes('/commits/'));
}

beforeEach(() => {
  installFetch();
  __resetVersionCacheForTests();
});

afterAll(() => { globalThis.fetch = realFetch; });

describe('resolveVersionBranch', () => {
  test('passes through the allowlisted branches', () => {
    expect(resolveVersionBranch('main')).toBe('main');
    expect(resolveVersionBranch('dev')).toBe('dev');
  });

  test('falls back to the default for anything else', () => {
    // The value is client-supplied (a runner heartbeat body) and is interpolated
    // into a GitHub API URL, so it is both an unbounded cache key and an
    // outbound-request injection surface. Allowlist, never sanitise.
    for (const bad of [null, undefined, '', 'DEV', 'refs/heads/dev', '../../../orgs/x', 'main;rm', 42 as any]) {
      expect(resolveVersionBranch(bad)).toBe(DEFAULT_VERSION_BRANCH);
    }
  });
});

describe('getLatestVersion', () => {
  test('resolves the ref it was asked for', async () => {
    const v = await getLatestVersion('main');
    expect(v.latestCommit).toBe('sha-for-main');
    expect(v.branch).toBe('main');
    expect(commitRequests()).toHaveLength(1);
    expect(commitRequests()[0]).toContain('/commits/main');
  });

  test('defaults to the existing branch when called with no argument', async () => {
    const v = await getLatestVersion();
    expect(v.branch).toBe(DEFAULT_VERSION_BRANCH);
    expect(commitRequests()[0]).toContain(`/commits/${DEFAULT_VERSION_BRANCH}`);
  });

  test('caches per branch — two branches are two entries, not one', async () => {
    const main1 = await getLatestVersion('main');
    const dev1 = await getLatestVersion('dev');
    expect(main1.latestCommit).toBe('sha-for-main');
    expect(dev1.latestCommit).toBe('sha-for-dev');
    expect(commitRequests()).toHaveLength(2);

    // Both entries survive each other: a second branch must not evict the first.
    const main2 = await getLatestVersion('main');
    const dev2 = await getLatestVersion('dev');
    expect(main2.latestCommit).toBe('sha-for-main');
    expect(dev2.latestCommit).toBe('sha-for-dev');
    expect(commitRequests()).toHaveLength(2); // both served from cache
  });

  test('an unlisted branch falls back instead of being interpolated into the URL', async () => {
    const v = await getLatestVersion('../../../repos/someone-else/private');
    expect(v.branch).toBe(DEFAULT_VERSION_BRANCH);
    expect(v.latestCommit).toBe(`sha-for-${DEFAULT_VERSION_BRANCH}`);
    for (const url of requested) {
      expect(url).not.toContain('someone-else');
      expect(url).not.toContain('..');
    }
    // And it shares the default branch's cache entry rather than opening a new one.
    await getLatestVersion(DEFAULT_VERSION_BRANCH);
    expect(commitRequests()).toHaveLength(1);
  });

  test('serves a stale entry for the SAME branch when GitHub fails', async () => {
    await getLatestVersion('main');
    globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
    __ageVersionCacheForTests(10 * 60 * 1000);
    const again = await getLatestVersion('main');
    expect(again.latestCommit).toBe('sha-for-main');
  });

  test('throws for a branch with no entry at all when GitHub fails', async () => {
    await getLatestVersion('main');
    globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
    // 'dev' has no cached entry, so main's entry must not be substituted for it.
    await expect(getLatestVersion('dev')).rejects.toThrow('network down');
  });
});
