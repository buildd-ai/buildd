/**
 * The task page's PR details cache on a real database (spec 3ef37387 R-14,
 * R-15; lib/pr-details-cache.ts). A burst of renders of an open page (every
 * live refresh) schedules a refresh each; the claim on the cache row lets one
 * of them call GitHub, and a fresh answer makes none.
 */
import { describe, it, expect, beforeAll, mock } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q } from './harness';

assertDbConfigured();

const calls: string[] = [];
mock.module('../../src/lib/github', () => ({
  githubApi: async (_installId: number, path: string) => {
    calls.push(path);
    await new Promise(r => setTimeout(r, 20));
    if (path.endsWith('/reviews')) return [{ user: { login: 'a' }, state: 'APPROVED' }];
    if (path.includes('/check-runs')) return { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] };
    return { head: { sha: 'head1' }, mergeable: true, mergeable_state: 'clean' };
  },
}));

const { prDetailsKey, readPrDetails, refreshPrDetails } = await import('../../src/lib/pr-details-cache');

let workspaceId: string;

beforeAll(async () => {
  const slug = `pr-details-${Date.now().toString(36)}`;
  const [t] = await q<{ id: string }>(sql`INSERT INTO teams (name, slug) VALUES ('PR details team', ${slug}) RETURNING id`);
  const [inst] = await q<{ id: string }>(sql`
    INSERT INTO github_installations (installation_id, account_type, account_login, account_id)
    VALUES (${Math.floor(Date.now() / 1000) + 11}, 'Organization', 'example', 1) RETURNING id`);
  const [repo] = await q<{ id: string }>(sql`
    INSERT INTO github_repos (installation_id, repo_id, full_name, name, owner)
    VALUES (${inst.id}::uuid, ${Date.now() + 11}, 'example/pr-details', 'pr-details', 'example') RETURNING id`);
  const [ws] = await q<{ id: string }>(sql`
    INSERT INTO workspaces (name, team_id, repo, github_repo_id, github_installation_id)
    VALUES ('pr-details-ws', ${t.id}::uuid, 'example/pr-details', ${repo.id}::uuid, ${inst.id}::uuid) RETURNING id`);
  workspaceId = ws.id;
});

describe('PR details cache', () => {
  it('a burst of refreshes calls GitHub once; a fresh answer makes no call; an expired one refreshes', async () => {
    const key = prDetailsKey(workspaceId, 41, 'head1');
    expect(await readPrDetails(key)).toEqual({ details: null, fresh: false });

    await Promise.all(Array.from({ length: 5 }, () => refreshPrDetails({ key, workspaceId, prNumber: 41, otherRefs: [] })));
    // One refresh: the PR, its head's check runs, its reviews.
    expect(calls.filter(c => c.endsWith('/pulls/41'))).toHaveLength(1);
    expect(calls).toHaveLength(3);

    const read = await readPrDetails(key);
    expect(read.fresh).toBe(true);
    expect(read.details).toMatchObject({ headSha: 'head1', mergeable: true, reviews: { approved: 1 }, ciChecks: { total: 1, passed: 1 } });

    await refreshPrDetails({ key, workspaceId, prNumber: 41, otherRefs: [] });
    expect(calls).toHaveLength(3);

    await q(sql`UPDATE system_cache SET expires_at = now() - interval '1 second' WHERE key = ${key}`);
    expect((await readPrDetails(key)).fresh).toBe(false);
    await refreshPrDetails({ key, workspaceId, prNumber: 41, otherRefs: [] });
    expect(calls).toHaveLength(6);
  }, 60_000);
});
