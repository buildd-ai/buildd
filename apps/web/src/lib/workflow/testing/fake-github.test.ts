/**
 * The stateful fake GitHub (fake-github.ts) is only useful if production code
 * reads it the way it reads GitHub. So these drive it through the real readers
 * and writers — githubReader, mergePullRequest, updateBehindPrBranch and the
 * classifiers that turn their answers into kernel outcomes — and pin each fault.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

// mergePullRequest takes an installation token first; the fake answers the HTTP after that.
mock.module('@buildd/core/github-installation-auth', () => ({ getInstallationToken: async () => 'ghs_test', generateAppJWT: () => 'jwt' }));

const { FakeGithub } = await import('./fake-github');
const { mergePullRequest } = await import('@/lib/github');
const { updateBehindPrBranch } = await import('@/lib/pr-branch-update');
const { classifyMergeCall } = await import('../pr-landing-effects');

const REPO = 'acme/widgets';

function world(opts: ConstructorParameters<typeof FakeGithub>[0] = {}) {
  const gh = new FakeGithub(opts);
  gh.createRepo(REPO, { defaultBranch: 'dev', files: { 'a.ts': 'a1', 'b.ts': 'b1' } });
  const h1 = gh.push(REPO, 'feat/x', { 'a.ts': 'a2' });
  const pr = gh.openPr(REPO, { head: 'feat/x', base: 'dev', title: 'feat: x' });
  return { gh, h1, pr };
}

let restore: (() => void) | null = null;
let current: InstanceType<typeof FakeGithub> | null = null;
beforeAll(() => {
  // One global fetch for the file; each test points it at its own fake.
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (href.startsWith('https://api.github.com/') && current) return current.fetch(input, init);
    return original(input, init);
  }) as typeof fetch;
  restore = () => { globalThis.fetch = original; };
});
afterAll(() => restore?.());

describe('reads through the production githubReader', () => {
  test('readPr is the PR GitHub holds: head, base, open, unmerged', async () => {
    const { gh, h1, pr } = world();
    const live = await gh.reader().readPr(REPO, pr);
    expect(live).toMatchObject({ state: 'open', merged: false, headSha: h1, headRepoFullName: REPO, baseRef: 'dev', mergedAt: null, mergeCommitSha: null, mergeableState: 'clean' });
    expect(await gh.reader().readPr(REPO, 999_999)).toBeNull();
    expect(gh.unsupported).toEqual([]);
  });

  test('mergeability is computed lazily: unknown for N reads after every head or base move', async () => {
    const { gh, pr } = world({ faults: { mergeableUnknownReads: 2 } });
    const r = gh.reader();
    expect((await r.readPr(REPO, pr))!.mergeableState).toBe('unknown');
    expect((await r.readPr(REPO, pr))!.mergeableState).toBe('unknown');
    expect((await r.readPr(REPO, pr))!.mergeableState).toBe('clean');
    gh.advanceBase(REPO, 'dev', { 'c.ts': 'c1' });
    expect((await r.readPr(REPO, pr))!.mergeableState).toBe('unknown');
  });

  test('a conflicting base is dirty; a strict base that moved is behind; protection blocks', async () => {
    const { gh, pr } = world();
    gh.protect(REPO, 'dev', { strict: true });
    gh.advanceBase(REPO, 'dev', { 'b.ts': 'b2' });
    expect((await gh.reader().readPr(REPO, pr))!.mergeableState).toBe('behind');
    gh.advanceBase(REPO, 'dev', { 'a.ts': 'a-base' });
    expect((await gh.reader().readPr(REPO, pr))!.mergeableState).toBe('dirty');

    const w = world();
    w.gh.protect(REPO, 'dev', { requiredChecks: ['build'], requiredApprovals: 1 });
    expect((await w.gh.reader().readPr(REPO, w.pr))!.mergeableState).toBe('blocked');
    w.gh.greenCi(REPO, w.h1);
    w.gh.review(REPO, w.pr, { state: 'APPROVED' });
    expect((await w.gh.reader().readPr(REPO, w.pr))!.mergeableState).toBe('clean');
  });

  test('checks: ciGreen, checkRuns and failingChecks read the runs on a sha', async () => {
    const { gh, h1 } = world();
    const r = gh.reader();
    expect(await r.ciGreen!(REPO, h1)).toBeNull();
    expect(await r.checkRuns!(REPO, h1)).toBeNull();
    gh.setCheck(REPO, h1, 'build', { status: 'in_progress' });
    gh.setCheck(REPO, h1, 'lint', { conclusion: 'success' });
    expect(await r.ciGreen!(REPO, h1)).toBeNull();
    expect(await r.checkRuns!(REPO, h1)).toEqual({ complete: false, failing: [] });
    gh.setCheck(REPO, h1, 'build', { conclusion: 'failure' });
    expect(await r.ciGreen!(REPO, h1)).toBe(false);
    expect(await r.checkRuns!(REPO, h1)).toEqual({ complete: true, failing: ['build'] });
    expect((await r.failingChecks!(REPO, h1))!.sort()).toEqual(['CI', 'build']);
    gh.setCheck(REPO, h1, 'build', { conclusion: 'success' });
    expect(await r.ciGreen!(REPO, h1)).toBe(true);
  });

  test('ancestry, branch reads and content equivalence come from the commit graph', async () => {
    const { gh, h1, pr } = world();
    const r = gh.reader();
    gh.advanceBase(REPO, 'dev', { 'c.ts': 'c1' });
    const merged = gh.updateBranch(REPO, pr, { expectedHeadSha: h1 });
    expect(gh.pr(REPO, pr).headSha).toBe(merged);
    expect(await r.contains!(REPO, h1, merged)).toBe(true);
    expect(await r.contains!(REPO, merged, h1)).toBe(false);
    expect(await r.branchHead!(REPO, 'feat/x')).toBe(merged);
    // Merging the base in leaves the PR's own diff unchanged; a new edit does not.
    expect(await r.contentEquivalent!(REPO, 'dev', h1, merged)).toBe(true);
    const h3 = gh.push(REPO, 'feat/x', { 'a.ts': 'a3' });
    expect(await r.contentEquivalent!(REPO, 'dev', merged, h3)).toBe(false);
    // A rebase onto the base tip carries the same change.
    const rebased = gh.forcePush(REPO, 'feat/x');
    expect(await r.contentEquivalent!(REPO, 'dev', h3, rebased)).toBe(true);
    expect(gh.files(REPO, rebased)).toMatchObject({ 'a.ts': 'a3', 'c.ts': 'c1' });
  });

  test('a deleted base branch reads as deleted and closes its PRs', async () => {
    const { gh, pr } = world();
    gh.createBranch(REPO, 'mission/m');
    const h = gh.push(REPO, 'feat/y', { 'y.ts': 'y' });
    const onMission = gh.openPr(REPO, { head: 'feat/y', base: 'mission/m' });
    expect(await gh.reader().branchExists!(REPO, 'mission/m')).toBe(true);
    gh.deleteBranch(REPO, 'mission/m');
    expect(await gh.reader().branchExists!(REPO, 'mission/m')).toBe(false);
    expect(await gh.reader().readPr(REPO, onMission)).toMatchObject({ state: 'closed', merged: false, headSha: h });
    expect((await gh.reader().readPr(REPO, pr))!.state).toBe('open');
  });
});

describe('base retarget (24e1cfad)', () => {
  test('PATCH base keeps the head and sends pull_request.edited with changes.base', async () => {
    const { gh, pr, h1 } = world();
    gh.createBranch(REPO, 'release');
    gh.discardWebhooks();
    await gh.request('PATCH', `/repos/${REPO}/pulls/${pr}`, { base: 'release' });
    expect(await gh.reader().readPr(REPO, pr)).toMatchObject({ baseRef: 'release', headSha: h1, state: 'open' });
    const edited = gh.pendingWebhooks().find((d) => d.name === 'pull_request' && (d.payload as { action?: string }).action === 'edited');
    expect((edited?.payload as { changes?: unknown })?.changes).toMatchObject({ base: { ref: { from: 'dev' } } });
  });

  test('deleting a merged PR\'s head branch retargets the PRs stacked on it to that PR\'s base, not closes them', async () => {
    const { gh, pr } = world();
    gh.createBranch(REPO, 'feat/top', 'feat/x');
    const hb = gh.push(REPO, 'feat/top', { 'c.ts': 'c1' });
    const top = gh.openPr(REPO, { head: 'feat/top', base: 'feat/x' });
    gh.mergePr(REPO, pr, { method: 'squash' });
    gh.deleteBranch(REPO, 'feat/x');
    expect(await gh.reader().readPr(REPO, top)).toMatchObject({ state: 'open', baseRef: 'dev', headSha: hb });
  });

  test('baseDiffEquivalent: a squash-landed parent leaves a stacked change equivalent; a base missing the parent does not', async () => {
    const { gh, pr } = world();
    gh.createBranch(REPO, 'release'); // the original dev: it lacks feat/x's change
    gh.createBranch(REPO, 'feat/top', 'feat/x');
    const head = gh.push(REPO, 'feat/top', { 'c.ts': 'c1' });
    gh.mergePr(REPO, pr, { method: 'squash' });
    const r = gh.reader();
    expect(await r.baseDiffEquivalent!(REPO, 'feat/x', 'dev', head)).toBe(true);
    expect(await r.baseDiffEquivalent!(REPO, 'feat/x', 'release', head)).toBe(false);
    expect(await r.baseDiffEquivalent!(REPO, 'gone', 'dev', head)).toBe(false);
  });
});

describe('writes through the production callers', () => {
  test('a pinned merge lands: the base advances to the merge commit and the PR reads merged', async () => {
    const { gh, h1, pr } = world();
    current = gh;
    const res = await mergePullRequest(1, REPO, pr, 'squash', h1);
    expect(classifyMergeCall(res)).toBe('merged');
    const live = await gh.reader().readPr(REPO, pr);
    expect(live).toMatchObject({ state: 'closed', merged: true, headSha: h1 });
    expect(live!.mergeCommitSha).toBe(gh.branchHead(REPO, 'dev'));
    expect(gh.files(REPO, 'dev')).toMatchObject({ 'a.ts': 'a2', 'b.ts': 'b1' });
    // A replay at the same head is a clean refusal, never a second merge.
    expect(classifyMergeCall(await mergePullRequest(1, REPO, pr, 'squash', h1))).toBe('indeterminate');
  });

  test('the head moves between the read and the merge: 409, nothing landed', async () => {
    const { gh, h1, pr } = world({ faults: { headMovesBeforeWrite: 1 } });
    current = gh;
    const res = await mergePullRequest(1, REPO, pr, 'squash', h1);
    expect(res).toMatchObject({ merged: false, status: 409 });
    expect(classifyMergeCall(res)).toBe('not_merged');
    expect(gh.pr(REPO, pr)).toMatchObject({ merged: false, state: 'open' });
    expect(gh.pr(REPO, pr).headSha).not.toBe(h1);
  });

  test('strict and behind: the merge says out of date (a refresh), update-branch refreshes it', async () => {
    const { gh, h1, pr } = world();
    current = gh;
    gh.protect(REPO, 'dev', { strict: true });
    gh.advanceBase(REPO, 'dev', { 'c.ts': 'c1' });
    expect(classifyMergeCall(await mergePullRequest(1, REPO, pr, 'squash', h1))).toBe('behind');
    expect(await updateBehindPrBranch({ installationId: 1, repoFullName: REPO, prNumber: pr, headSha: 'f'.repeat(40), api: gh.api })).toMatchObject({ updated: false, failure: 'head_changed' });
    expect(await updateBehindPrBranch({ installationId: 1, repoFullName: REPO, prNumber: pr, headSha: h1, api: gh.api })).toEqual({ updated: true });
    const head = gh.pr(REPO, pr).headSha;
    expect(await updateBehindPrBranch({ installationId: 1, repoFullName: REPO, prNumber: pr, headSha: head, api: gh.api })).toMatchObject({ updated: false, failure: 'up_to_date' });
    expect(classifyMergeCall(await mergePullRequest(1, REPO, pr, 'squash', head))).toBe('merged');
  });

  test('a textual conflict is GitHub\'s own 422 "merge conflict", and the merge is refused', async () => {
    const { gh, h1, pr } = world();
    current = gh;
    gh.advanceBase(REPO, 'dev', { 'a.ts': 'a-base' });
    expect(await updateBehindPrBranch({ installationId: 1, repoFullName: REPO, prNumber: pr, headSha: h1, api: gh.api })).toMatchObject({ updated: false, failure: 'conflict' });
    expect((await mergePullRequest(1, REPO, pr, 'squash', h1)).merged).toBe(false);
  });

  test('a lost answer: the merge applied but the caller saw a 502 with no body', async () => {
    const { gh, h1, pr } = world({ faults: { lostResponse: 1, callMatch: /\/merge$/ } });
    current = gh;
    const res = await mergePullRequest(1, REPO, pr, 'squash', h1);
    expect(res).toMatchObject({ merged: false, indeterminate: true, status: 502 });
    expect(classifyMergeCall(res)).toBe('indeterminate');
    expect((await gh.reader().readPr(REPO, pr))!.merged).toBe(true);
  });

  test('5xx and rate limits on any call: githubApi\'s error format, read as unknown, never as a fact', async () => {
    const down = world({ faults: { serverError: 1 } });
    expect(await down.gh.reader().readPr(REPO, down.pr)).toBeNull();
    expect(await down.gh.reader().branchExists!(REPO, 'dev')).toBeNull();
    expect(await updateBehindPrBranch({ installationId: 1, repoFullName: REPO, prNumber: down.pr, headSha: down.h1, api: down.gh.api })).toMatchObject({ failure: 'transient' });
    const limited = world({ faults: { rateLimit: 1 } });
    await expect(limited.gh.api(1, `/repos/${REPO}/pulls/${limited.pr}`)).rejects.toThrow(/^GitHub API error: 403 .*rate limit exceeded/);
    expect(await updateBehindPrBranch({ installationId: 1, repoFullName: REPO, prNumber: limited.pr, headSha: limited.h1, api: limited.gh.api })).toMatchObject({ failure: 'rate_limit' });
    // Nothing was applied by a refused call.
    expect(limited.gh.pr(REPO, limited.pr).headSha).toBe(limited.h1);
    // failNext: one deterministic failure on one route.
    const once = world();
    once.gh.failNext(/^GET .*\/pulls\/\d+$/, 503, 'Service Unavailable');
    expect(await once.gh.reader().readPr(REPO, once.pr)).toBeNull();
    expect(await once.gh.reader().readPr(REPO, once.pr)).not.toBeNull();
  });

  test('a rate-limited merge: 429 / 403 with retry-after or x-ratelimit-reset, nothing applied, and the caller learns when to come back', async () => {
    const { gh, h1, pr } = world();
    current = gh;
    gh.failNext(/^PUT .*\/merge$/, 429, 'You have exceeded a secondary rate limit.', { 'retry-after': '90' });
    const secondary = await mergePullRequest(1, REPO, pr, 'squash', h1);
    expect(secondary).toMatchObject({ merged: false, status: 429, retryAfterMs: 90_000 });
    expect(classifyMergeCall(secondary)).toBe('not_merged');
    const reset = Math.floor(Date.now() / 1000) + 300;
    gh.failNext(/^PUT .*\/merge$/, 403, 'API rate limit exceeded for installation ID 1.', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) });
    const primary = await mergePullRequest(1, REPO, pr, 'squash', h1);
    expect(primary.status).toBe(403);
    expect(primary.retryAfterMs).toBeGreaterThan(290_000);
    expect(primary.retryAfterMs).toBeLessThanOrEqual(300_000);
    expect(classifyMergeCall(primary)).toBe('not_merged');
    expect(gh.pr(REPO, pr).merged).toBe(false);
    expect(classifyMergeCall(await mergePullRequest(1, REPO, pr, 'squash', h1))).toBe('merged');
  });

  test('draft: converted_to_draft / ready_for_review webhooks, the read says draft, and the merge is refused until ready', async () => {
    const { gh, h1, pr } = world();
    current = gh;
    const actions: string[] = [];
    gh.onWebhook((d) => { if (d.name === 'pull_request') actions.push(String(d.payload.action)); });
    gh.greenCi(REPO, h1);
    gh.setDraft(REPO, pr, true);
    gh.setDraft(REPO, pr, true); // already a draft: no event
    expect(await gh.reader().readPr(REPO, pr)).toMatchObject({ draft: true });
    const refused = await mergePullRequest(1, REPO, pr, 'squash', h1);
    expect(refused).toMatchObject({ merged: false, status: 405 });
    expect(classifyMergeCall(refused)).toBe('not_merged');
    gh.setDraft(REPO, pr, false);
    expect((await gh.reader().readPr(REPO, pr))?.draft).toBeFalsy();
    await gh.deliverWebhooks();
    expect(actions.filter((a) => a !== 'opened' && a !== 'synchronize')).toEqual(['converted_to_draft', 'ready_for_review']);
    expect(classifyMergeCall(await mergePullRequest(1, REPO, pr, 'squash', h1))).toBe('merged');
  });

  test('check runs reported for the previous head', async () => {
    const { gh, h1 } = world({ faults: { staleChecks: 1 } });
    gh.greenCi(REPO, h1);
    const h2 = gh.push(REPO, 'feat/x', { 'a.ts': 'a3' });
    gh.setCheck(REPO, h2, 'build', { conclusion: 'failure' });
    // The new head is red, but the read answers with the old head's green runs.
    expect(await gh.reader().ciGreen!(REPO, h2)).toBe(true);
    gh.setFaults({ staleChecks: 0 });
    expect(await gh.reader().ciGreen!(REPO, h2)).toBe(false);
  });

  test('reviews posted through the API are listed with REST\'s uppercase state', async () => {
    const { gh, h1, pr } = world();
    await gh.api(1, `/repos/${REPO}/pulls/${pr}/reviews`, { method: 'POST', body: JSON.stringify({ commit_id: h1, event: 'APPROVE', body: 'lgtm' }) });
    const list = await gh.api(1, `/repos/${REPO}/pulls/${pr}/reviews`);
    expect(list).toEqual([expect.objectContaining({ commit_id: h1, state: 'APPROVED', body: 'lgtm', user: expect.objectContaining({ login: 'buildd[bot]' }) })]);
  });

  test('issue comments: create, list, edit, delete', async () => {
    const { gh, pr } = world();
    const c = await gh.api(1, `/repos/${REPO}/issues/${pr}/comments`, { method: 'POST', body: JSON.stringify({ body: 'one' }) });
    await gh.api(1, `/repos/${REPO}/issues/comments/${c.id}`, { method: 'PATCH', body: JSON.stringify({ body: 'two' }) });
    expect((await gh.api(1, `/repos/${REPO}/issues/${pr}/comments?per_page=100&page=1`)).map((x: { body: string }) => x.body)).toEqual(['two']);
    await gh.api(1, `/repos/${REPO}/issues/comments/${c.id}`, { method: 'DELETE' });
    expect(await gh.api(1, `/repos/${REPO}/issues/${pr}/comments`)).toEqual([]);
  });

  test('an unmodelled route answers 404 and is recorded', async () => {
    const { gh } = world();
    await expect(gh.api(1, `/repos/${REPO}/git/trees`, { method: 'POST', body: '{}' })).rejects.toThrow(/404/);
    expect(gh.unsupported).toEqual([`POST /repos/${REPO}/git/trees`]);
  });
});

describe('webhooks: GitHub payload shapes, handed over as hints', () => {
  const collect = (gh: InstanceType<typeof FakeGithub>) => {
    const seen: Array<{ name: string; action?: string; id: string }> = [];
    gh.onWebhook((d) => { seen.push({ name: d.name, action: d.payload.action, id: d.id }); });
    return seen;
  };

  test('a PR lifecycle raises opened, synchronize, review, check and closed(merged) with real fields', async () => {
    const { gh, h1, pr } = world();
    const payloads: Array<{ name: string; payload: Record<string, any> }> = [];
    gh.onWebhook((d) => { payloads.push(d); });
    const h2 = gh.push(REPO, 'feat/x', { 'a.ts': 'a3' });
    gh.greenCi(REPO, h2);
    gh.review(REPO, pr, { state: 'APPROVED' });
    gh.mergePr(REPO, pr);
    await gh.deliverWebhooks();
    const pull = (action: string) => payloads.find((p) => p.name === 'pull_request' && p.payload.action === action)!.payload;
    expect(pull('opened')).toMatchObject({
      number: pr, installation: { id: 1 }, repository: { full_name: REPO, default_branch: 'dev' }, sender: { login: 'dev' },
      pull_request: { number: pr, state: 'open', merged: false, head: { ref: 'feat/x', sha: h1, repo: { full_name: REPO } }, base: { ref: 'dev' } },
    });
    expect(pull('synchronize')).toMatchObject({ before: h1, after: h2, pull_request: { head: { sha: h2 } } });
    const closed = pull('closed');
    expect(closed.pull_request).toMatchObject({ state: 'closed', merged: true, merge_commit_sha: gh.branchHead(REPO, 'dev') });
    expect(closed.pull_request.merged_at).toEqual(expect.any(String));
    const review = payloads.find((p) => p.name === 'pull_request_review')!.payload;
    expect(review).toMatchObject({ action: 'submitted', review: { state: 'approved', commit_id: h2 }, pull_request: { number: pr } });
    const suite = payloads.find((p) => p.name === 'check_suite')!.payload;
    expect(suite).toMatchObject({ action: 'completed', check_suite: { head_sha: h2, status: 'completed', conclusion: 'success', pull_requests: [{ number: pr }] } });
    const push = payloads.find((p) => p.name === 'push' && p.payload.ref === 'refs/heads/dev')!.payload;
    expect(push).toMatchObject({ forced: false, after: gh.branchHead(REPO, 'dev') });
    expect(gh.pendingWebhooks()).toHaveLength(0);
  });

  test('drop, duplicate (same delivery id) and reorder', async () => {
    const dropped = world({ faults: { webhookDrop: 1 } });
    const seenDropped = collect(dropped.gh);
    await dropped.gh.deliverWebhooks();
    expect(seenDropped).toEqual([]);
    expect(dropped.gh.dropped.length).toBeGreaterThan(0);

    const dup = world({ faults: { webhookDuplicate: 1 } });
    const seenDup = collect(dup.gh);
    await dup.gh.deliverWebhooks({ names: ['pull_request'] });
    expect(seenDup).toHaveLength(2);
    expect(seenDup[0].id).toBe(seenDup[1].id);

    const re = world({ faults: { webhookReorder: 1 } });
    re.gh.closePr(REPO, re.pr);
    const seenRe = collect(re.gh);
    await re.gh.deliverWebhooks({ names: ['pull_request'] });
    expect(seenRe.map((s) => s.action)).toEqual(['closed', 'opened']);
  });

  test('early: the hint arrives before the read model shows the event', async () => {
    const { gh, h1, pr } = world({ faults: { webhookEarly: 1 } });
    const reads: Array<string | null> = [];
    gh.onWebhook(async (d) => {
      if (d.name !== 'pull_request') return;
      const live = await gh.reader().readPr(REPO, pr);
      reads.push(live ? `${d.payload.action}:${live.headSha === h1 ? 'h1' : 'new'}` : `${d.payload.action}:404`);
    });
    gh.push(REPO, 'feat/x', { 'a.ts': 'a3' });
    await gh.deliverWebhooks();
    // A new PR is not readable yet; a push still reads the old head.
    expect(reads).toEqual(['opened:404', 'synchronize:h1']);
    // After the delivery the read model has caught up.
    expect((await gh.reader().readPr(REPO, pr))!.headSha).not.toBe(h1);
  });

  test('faults are seeded: the same seed draws the same sequence, each fault on its own stream', async () => {
    const run = async (seed: number, extra: Record<string, number> = {}) => {
      const gh = new FakeGithub({ seed, faults: { webhookDrop: 0.5, ...extra } });
      gh.createRepo(REPO, { defaultBranch: 'dev' });
      for (let i = 0; i < 12; i++) gh.push(REPO, 'feat/z', { 'z.ts': `z${i}` });
      const seen = collect(gh);
      await gh.deliverWebhooks();
      return seen.length;
    };
    expect(await run(7)).toBe(await run(7));
    const outcomes = new Set(await Promise.all([1, 2, 3, 4, 5, 6].map((s) => run(s))));
    expect(outcomes.size).toBeGreaterThan(1);
    // Switching another fault on does not change which webhooks drop.
    expect(await run(7, { rateLimit: 0.9 })).toBe(await run(7));
  });
});
