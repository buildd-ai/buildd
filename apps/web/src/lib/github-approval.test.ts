import { it, expect } from 'bun:test';
import { readGithubApproval } from './github-approval';
it('reads required approval separately from bots and stale human reviews', async () => {
  const api = async () => ({ data: { repository: { pullRequest: { headRefOid: 'new', reviewDecision: 'REVIEW_REQUIRED', reviews: { nodes: [
    { state: 'APPROVED', author: { login: 'bot', __typename: 'Bot' }, commit: { oid: 'new' } },
    { state: 'APPROVED', author: { login: 'person', __typename: 'User' }, commit: { oid: 'old' } },
  ] } } } } });
  expect(await readGithubApproval(1, 'example/project', 7, api)).toEqual({ reviewDecision: 'REVIEW_REQUIRED', humanApproved: false });
});
it('a later dismissal or change request supersedes an approval', async () => {
  const api = async () => ({ data: { repository: { pullRequest: { headRefOid: 'new', reviewDecision: null, reviews: { nodes: [
    { state: 'APPROVED', author: { login: 'person', __typename: 'User' }, commit: { oid: 'new' } },
    { state: 'CHANGES_REQUESTED', author: { login: 'person', __typename: 'User' }, commit: { oid: 'new' } },
  ] } } } } });
  expect((await readGithubApproval(1, 'example/project', 7, api)).humanApproved).toBe(false);
});
it('accepts an effective human approval of the current head', async () => {
  const api = async () => ({ data: { repository: { pullRequest: { headRefOid: 'new', reviewDecision: 'APPROVED', reviews: { nodes: [
    { state: 'APPROVED', author: { login: 'person', __typename: 'User' }, commit: { oid: 'new' } },
  ] } } } } });
  expect((await readGithubApproval(1, 'example/project', 7, api)).humanApproved).toBe(true);
});
// workflow-kernel-library.md §4: a COMMENTED review is never an approval. #4686
// was merged over two COMMENTED reviews that said "changes requested".
it('a COMMENTED review of the current head is not an approval, and does not undo a change request', async () => {
  const lone = async () => ({ data: { repository: { pullRequest: { headRefOid: 'new', reviewDecision: null, reviews: { nodes: [
    { state: 'COMMENTED', author: { login: 'person', __typename: 'User' }, commit: { oid: 'new' } },
  ] } } } } });
  expect(await readGithubApproval(1, 'example/project', 7, lone)).toEqual({ reviewDecision: null, humanApproved: false });
  const afterChanges = async () => ({ data: { repository: { pullRequest: { headRefOid: 'new', reviewDecision: 'CHANGES_REQUESTED', reviews: { nodes: [
    { state: 'APPROVED', author: { login: 'person', __typename: 'User' }, commit: { oid: 'old' } },
    { state: 'CHANGES_REQUESTED', author: { login: 'person', __typename: 'User' }, commit: { oid: 'new' } },
    { state: 'COMMENTED', author: { login: 'person', __typename: 'User' }, commit: { oid: 'new' } },
  ] } } } } });
  expect((await readGithubApproval(1, 'example/project', 7, afterChanges)).humanApproved).toBe(false);
});
it('never treats a failed GitHub query as satisfied approval', async () => {
  await expect(readGithubApproval(1, 'example/project', 7, async () => ({ errors: [{ message: 'Unavailable' }] }))).rejects.toThrow();
});

// ── Cache: Home renders must not re-ask GitHub for heads it already read ─────
import { readGithubApprovalCached, invalidateGithubApproval, loadGithubApprovals, githubApprovalCacheKey, type ApprovalCache } from './github-approval';

function memoryCache(): ApprovalCache & { store: Map<string, unknown>; ttls: number[] } {
  const store = new Map<string, unknown>();
  const ttls: number[] = [];
  return {
    store, ttls,
    get: async <T>(k: string) => (store.has(k) ? store.get(k) as T : null),
    set: async <T>(k: string, v: T, ttl: number) => { store.set(k, v); ttls.push(ttl); return true; },
    del: async (k: string) => { store.delete(k); },
  };
}
function approvingApi(head: string) {
  const calls: string[] = [];
  const api = async () => {
    calls.push(head);
    return { data: { repository: { pullRequest: { headRefOid: head, reviewDecision: 'APPROVED', reviews: { nodes: [
      { state: 'APPROVED', author: { login: 'person', __typename: 'User' }, commit: { oid: head } },
    ] } } } } };
  };
  return { api, calls };
}

it('a second render with the same heads makes no GraphQL call', async () => {
  const cache = memoryCache();
  const { api, calls } = approvingApi('h1');
  const first = await readGithubApprovalCached(1, 'example/project', 7, { workerSha: 'h1', api, cache });
  const second = await readGithubApprovalCached(1, 'example/project', 7, { workerSha: 'h1', api, cache });
  expect(first).toEqual({ reviewDecision: 'APPROVED', humanApproved: true });
  expect(second).toEqual(first);
  expect(calls.length).toBe(1);
  expect(cache.ttls.every(t => t > 0 && t <= 120)).toBe(true);
});

it('a new head misses the cache, so an approval of the old head never reads as approved', async () => {
  const cache = memoryCache();
  await readGithubApprovalCached(1, 'example/project', 7, { workerSha: 'h1', api: approvingApi('h1').api, cache });
  // The worker pushed h2; GitHub's approval was of h1.
  const calls: number[] = [];
  const api = async () => {
    calls.push(1);
    return { data: { repository: { pullRequest: { headRefOid: 'h2', reviewDecision: 'REVIEW_REQUIRED', reviews: { nodes: [
      { state: 'APPROVED', author: { login: 'person', __typename: 'User' }, commit: { oid: 'h1' } },
    ] } } } } };
  };
  const facts = await readGithubApprovalCached(1, 'example/project', 7, { workerSha: 'h2', api, cache });
  expect(calls.length).toBe(1);
  expect(facts).toEqual({ reviewDecision: 'REVIEW_REQUIRED', humanApproved: false });
});

it('a webhook invalidation (push by someone else, review dismissed) forces a live read', async () => {
  const cache = memoryCache();
  const { api, calls } = approvingApi('h1');
  await readGithubApprovalCached(1, 'Example/Project', 7, { workerSha: 'h1', api, cache });
  await invalidateGithubApproval('example/project', 7, cache);
  await readGithubApprovalCached(1, 'example/project', 7, { workerSha: 'h1', api, cache });
  expect(calls.length).toBe(2);
  expect(githubApprovalCacheKey('Example/Project', 7)).toBe(githubApprovalCacheKey('example/project', 7));
});

it('fails open to a live read when the cache cannot answer, and never caches a failed read', async () => {
  const broken: ApprovalCache = { get: async () => undefined, set: async () => false, del: async () => {} };
  const { api, calls } = approvingApi('h1');
  expect((await readGithubApprovalCached(1, 'example/project', 7, { workerSha: 'h1', api, cache: broken })).humanApproved).toBe(true);
  expect(calls.length).toBe(1);
  const cache = memoryCache();
  await expect(readGithubApprovalCached(1, 'example/project', 7, { workerSha: 'h1', api: async () => ({ errors: [{ message: 'x' }] }), cache })).rejects.toThrow();
  expect(cache.store.size).toBe(0);
});

it('a malformed cached entry is ignored, not trusted', async () => {
  const cache = memoryCache();
  cache.store.set(githubApprovalCacheKey('example/project', 7), { facts: { humanApproved: true }, workerSha: 'h1' });
  const { api, calls } = approvingApi('h1');
  await readGithubApprovalCached(1, 'example/project', 7, { workerSha: 'h1', api, cache });
  expect(calls.length).toBe(1);
});

it('runs every lookup in one bounded pass: a slow PR never holds back the rest', async () => {
  let inFlight = 0, peak = 0;
  let releaseSlow!: () => void;
  const slow = new Promise<void>(r => { releaseSlow = r; });
  const done: number[] = [];
  const items = Array.from({ length: 20 }, (_, i) => i);
  const run = loadGithubApprovals(items, 8, async i => {
    inFlight++; peak = Math.max(peak, inFlight);
    if (i === 0) await slow; else await new Promise(r => setTimeout(r, 1));
    inFlight--; done.push(i);
  });
  await new Promise(r => setTimeout(r, 50));
  // Serial batches of 8 would leave items 8..19 waiting on item 0.
  expect(done.length).toBe(19);
  releaseSlow();
  await run;
  expect(done.length).toBe(20);
  expect(peak).toBe(8);
});
