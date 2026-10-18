/**
 * Every open PR head carries `Buildd / Review approval` (docs/specs/workflow-kernel-library.md
 * §4, AC-37, AC-38): the open-PR status sweep on real Postgres against the stateful fake
 * GitHub. Linked repos come from the real `workspaces` / `github_repos` / `github_installations`
 * join; ownership, the delivery and the republish effect from the kernel's own tables.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { q } from './harness';
import { world, type World } from './workflow-scenarios-world';

const { publishOpenPrStatuses, linkedRepos, republishKey } = await import('../../src/lib/workflow/open-pr-status');
const { openPrReviewReads } = await import('../../src/lib/release/open-pr-review');
const { githubReader } = await import('../../src/lib/workflow/github-facts');
const { githubApi } = await import('../../src/lib/github');

const CONTEXT = 'Buildd / Review approval';

let w: World;
afterEach(() => w?.dispose());

/** The sweep over this world's workspace only: other worlds' repos live on fakes that are gone. */
const sweep = (w: World) => publishOpenPrStatuses({
  repos: async () => (await linkedRepos()).filter((r) => r.workspaceId === w.workspaceId),
  reviews: async () => openPrReviewReads(),
});
const shown = (w: World, sha: string) => githubReader(w.installationId).statusOf!(w.repo, sha, CONTEXT);

describe('the open-PR status sweep', () => {
  test('a dependency bot\'s PR no delivery owns gets pending "Review not requested"; a second pass writes nothing', async () => {
    w = await world();
    w.gh.createBranch(w.repo, 'renovate/lib-2.x', 'dev');
    const head = w.gh.push(w.repo, 'renovate/lib-2.x', { 'package.json': '{"lib":"2"}\n' }, { message: 'chore(deps): lib 2' });
    const prNumber = w.gh.openPr(w.repo, { head: 'renovate/lib-2.x', base: 'dev', user: 'renovate[bot]' });
    await w.deliver();

    const first = await sweep(w);
    expect(first).toMatchObject({ repos: 1, checked: 1, published: 1, errors: 0, coverage: { verdict: 'covered', missing: [] } });
    expect(await shown(w, head)).toMatchObject({ state: 'pending', description: 'Review not requested: no buildd review covers ' + head.slice(0, 7) + ' yet' });
    expect(await githubReader(w.installationId).statusOf!(w.repo, head, 'buildd/landing')).toMatchObject({ state: 'pending' });

    const writes = () => w.gh.calls.filter((c) => c.method === 'POST' && c.path === `/repos/${w.repo}/statuses/${head}`).length;
    const before = writes();
    expect(await sweep(w)).toMatchObject({ published: 0, unchanged: 1, coverage: { verdict: 'covered' } });
    expect(writes()).toBe(before);
    expect(prNumber).toBeGreaterThan(0);
  });

  test('a kernel-owned head showing something other than the kernel\'s answer is republished by the kernel, once per version', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/flag', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);
    const head = (await w.delivery(pr)).currentHeadSha!;
    // A head whose status predates the current name (or was overwritten): what GitHub shows is not the kernel's answer.
    await githubApi(w.installationId, `/repos/${w.repo}/statuses/${head}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'pending', context: CONTEXT, description: 'stale' }),
    });

    const r = await sweep(w);
    expect(r).toMatchObject({ checked: 1, republished: 1, published: 0, errors: 0, coverage: { verdict: 'covered' } });
    expect(await shown(w, head)).toMatchObject({ state: 'success' });
    const version = (await w.delivery(pr)).version;
    const rows = await q<{ status: string }>(sql`SELECT status FROM workflow_effects WHERE dedupe_key = ${republishKey(pr.deliveryId, version)}`);
    expect(rows.map((x) => x.status)).toEqual(['done']);

    // Idempotent: GitHub shows the answer, nothing is enqueued again.
    expect(await sweep(w)).toMatchObject({ republished: 0, unchanged: 1 });
    expect((await q(sql`SELECT 1 FROM workflow_effects WHERE delivery_id = ${pr.deliveryId}::uuid AND dedupe_key LIKE '%:open-pr-sweep'`)).length).toBe(1);
  });

  test('AC-38: approved at H1, H2 pushed and not yet imported: H2 is pending, never H1\'s success', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/push', files: { 'src/a.ts': 'export const a = 3;\n' } });
    await w.approve(pr);
    // A push the kernel has not seen (its webhook not delivered yet).
    const h2 = w.gh.push(w.repo, 'feat/push', { 'src/b.ts': 'export const b = 9;\n' }, { message: 'more' });
    const r = await sweep(w);
    expect(r.errors).toBe(0);
    expect(await shown(w, h2)).toMatchObject({ state: 'pending' });
  });
});
