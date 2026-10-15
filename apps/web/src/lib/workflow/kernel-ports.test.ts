/**
 * buildd's adapters for the kernel's ports (kernel-ports.ts): GithubWrites over
 * `@/lib/github`, GitHub per workspace, and the composition's shape. The
 * handlers that run on them are the package's, proven on fake ports by the
 * conformance scenarios and on Postgres by apps/web/tests/db.
 */
import { describe, expect, test } from 'bun:test';
import type { MergePullRequestResult } from '@/lib/github';
import { builddGithubFor, builddGithubWrites, builddKernelPorts, builddWork } from './kernel-ports';
import { mergeAnswerOf } from './pr-landing-effects';

function fakeApi(answers: Record<string, unknown> = {}) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const api = async (_i: number, path: string, opts?: RequestInit): Promise<unknown> => {
    const method = opts?.method ?? 'GET';
    calls.push({ path, method, body: opts?.body ? JSON.parse(String(opts.body)) : null });
    return answers[`${method} ${path}`] ?? null;
  };
  return { api, calls };
}

describe('GithubWrites over @/lib/github', () => {
  test('mergeAtHead pins the head, defaults to squash, and answers in T16 terms', async () => {
    const seen: unknown[] = [];
    const merge = async (...args: unknown[]): Promise<MergePullRequestResult> => { seen.push(args); return { merged: false, message: 'Head branch was modified. Review and try the merge again.', status: 405 }; };
    const w = builddGithubWrites(7, mergeAnswerOf, { merge: merge as never });
    const ans = await w.mergeAtHead({ repoFullName: 'acme/widgets', prNumber: 3, headSha: 'H1' });
    expect(seen).toEqual([[7, 'acme/widgets', 3, 'squash', 'H1']]);
    expect(ans).toEqual({ outcome: 'not_merged', detail: 'Head branch was modified. Review and try the merge again.', retryAt: null });
  });

  test('postReview: a verdict goes through postPrReview (its own-PR and duplicate rules), a comment straight to the API', async () => {
    const reviews: unknown[] = [];
    const review = async (p: unknown) => { reviews.push(p); return { posted: true, reviewId: 42 }; };
    const { api, calls } = fakeApi({ 'POST /repos/acme/widgets/pulls/3/reviews': { id: 9 } });
    const w = builddGithubWrites(7, mergeAnswerOf, { api, review: review as never });
    expect(await w.postReview({ repoFullName: 'acme/widgets', prNumber: 3, commitId: 'H1', event: 'APPROVE', body: 'ok' })).toEqual({ id: '42', posted: true });
    expect(reviews).toEqual([{ installationId: 7, repoFullName: 'acme/widgets', prNumber: 3, headSha: 'H1', event: 'APPROVE', body: 'ok' }]);
    expect(await w.postReview({ repoFullName: 'acme/widgets', prNumber: 3, commitId: 'H1', event: 'COMMENT', body: 'fyi' })).toEqual({ id: '9', posted: true });
    expect(calls).toEqual([{ path: '/repos/acme/widgets/pulls/3/reviews', method: 'POST', body: { commit_id: 'H1', event: 'COMMENT', body: 'fyi' } }]);
  });

  test('postReview says when a verdict did not go up, and when it went up as a comment on the host\'s own PR', async () => {
    const refused = builddGithubWrites(7, mergeAnswerOf, { review: (async () => ({ posted: false, reason: 'a matching review already exists for this commit' })) as never });
    expect(await refused.postReview({ repoFullName: 'acme/widgets', prNumber: 3, commitId: 'H1', event: 'APPROVE', body: 'ok' }))
      .toEqual({ id: null, posted: false, reason: 'a matching review already exists for this commit' });
    const own = builddGithubWrites(7, mergeAnswerOf, { review: (async () => ({ posted: true, reviewId: 5, commentedOwnPr: true })) as never });
    expect(await own.postReview({ repoFullName: 'acme/widgets', prNumber: 3, commitId: 'H1', event: 'APPROVE', body: 'ok' })).toEqual({ id: '5', posted: true, commentedOwnPr: true });
  });

  test('upsertComment edits the oldest comment carrying the marker, else creates one', async () => {
    const list = 'GET /repos/acme/widgets/issues/3/comments?per_page=100&page=1';
    const withMarker = fakeApi({ [list]: [{ id: 12, body: 'x <!-- m -->' }, { id: 5, body: '<!-- m --> old' }, { id: 2, body: 'other' }] });
    expect(await builddGithubWrites(7, mergeAnswerOf, { api: withMarker.api }).upsertComment({ repoFullName: 'acme/widgets', prNumber: 3, marker: '<!-- m -->', body: 'new' })).toEqual({ id: '5' });
    expect(withMarker.calls.at(-1)).toEqual({ path: '/repos/acme/widgets/issues/comments/5', method: 'PATCH', body: { body: 'new' } });

    const none = fakeApi({ [list]: [], 'POST /repos/acme/widgets/issues/3/comments': { id: 77 } });
    expect(await builddGithubWrites(7, mergeAnswerOf, { api: none.api }).upsertComment({ repoFullName: 'acme/widgets', prNumber: 3, marker: '<!-- m -->', body: 'new' })).toEqual({ id: '77' });
  });

  test('publishStatus and deleteBranch address the commit and the encoded ref', async () => {
    const { api, calls } = fakeApi();
    const w = builddGithubWrites(7, mergeAnswerOf, { api });
    await w.publishStatus({ repoFullName: 'acme/widgets', sha: 'H1', context: 'buildd/landing', state: 'pending', description: 'waiting', targetUrl: 'https://example.test/t' });
    await w.deleteBranch({ repoFullName: 'acme/widgets', ref: 'mission/a b' });
    expect(calls).toEqual([
      { path: '/repos/acme/widgets/statuses/H1', method: 'POST', body: { state: 'pending', context: 'buildd/landing', description: 'waiting', target_url: 'https://example.test/t' } },
      { path: '/repos/acme/widgets/git/refs/heads/mission%2Fa%20b', method: 'DELETE', body: null },
    ]);
  });
});

describe('GitHub per workspace', () => {
  test('no installation is null (the handler fails loudly); an installation gets its reads and writes', async () => {
    const reader = (id: number) => ({ readPr: async () => null, installation: id }) as never;
    const none = builddGithubFor(mergeAnswerOf, { repoFor: async () => null, reader });
    expect(await none('w1')).toBeNull();
    const some = builddGithubFor(mergeAnswerOf, { repoFor: async () => ({ installationId: 4, repoFullName: 'acme/widgets', gitConfig: null }), reader });
    const gh = await some('w1');
    expect((gh as unknown as { installation: number }).installation).toBe(4);
    expect(typeof gh?.writes?.mergeAtHead).toBe('function');
  });
});

test('the composed ports carry every port the package handlers reach', () => {
  const ports = builddKernelPorts({
    mergeAnswerOf, notify: { activity: async () => {}, team: async () => {} }, lifecycle: {} as never, work: {}, escalate: {} as never, evidence: {} as never,
    reviews: {} as never, conflicts: {} as never, handOff: {} as never, decide: {} as never,
  });
  expect(Object.keys(ports).sort()).toEqual([
    'clock', 'conflicts', 'decide', 'escalate', 'evidence', 'githubFor', 'handOff', 'ingest', 'lifecycle', 'notify', 'policy', 'reviews', 'store', 'trunk', 'work',
  ]);
});

describe('builddWork', () => {
  // Neither case reaches the task insert, so neither touches the database.
  const req = { role: 'ci_fix', workspaceId: 'w', target: { repoFullName: 'acme/x', prNumber: 1 }, lineage: { deliveryId: 'd' }, dedupeKey: 'k' };
  test('a role with no builder is an error, so the effect backs off instead of filing nothing', async () => {
    await expect(builddWork({}).file(req)).rejects.toThrow('no task builder for role ci_fix');
  });
  test('a builder that cannot file now answers skipped, and nothing is inserted', async () => {
    expect(await builddWork({ ci_fix: async () => ({ skipped: 'missing_context' }) }).file(req)).toEqual({ taskId: null, created: false, skipped: 'missing_context' });
  });
  test('a role that files through its own path (the reviewer) answers what that path filed', async () => {
    expect(await builddWork({ review: async () => ({ filed: { taskId: 'r1', created: false } }) }).file({ ...req, role: 'review' })).toEqual({ taskId: 'r1', created: false });
  });
});
