/**
 * Living Spec revisions citing repo specs at an exact commit (D-1), against
 * real Postgres and a fake GitHub that has commits and a branch that moves.
 * The repo comes from the workspace's github_repos link; the fake answers a
 * contents read by whatever ref it is given, so a reader that followed the
 * branch would see the branch's newer text.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const C1 = '1111111111111111111111111111111111111111';
const C2 = '2222222222222222222222222222222222222222';
const UNKNOWN = '9999999999999999999999999999999999999999';
const PATH = 'docs/specs/checkout.md';
const V1 = '# Checkout\n\n## Totals\nR-1: totals are in the shopper currency.\n\n## Rates\nRates refresh hourly.\n';
const V2 = '# Checkout\n\n## Totals\nR-1: totals are in the shopper currency, rounded half-even.\n';

/** One repo: commits by SHA, and a branch that points at one of them. */
const world = {
  commits: new Map<string, Record<string, string>>([[C1, { [PATH]: V1 }], [C2, { [PATH]: V2 }]]),
  branches: new Map<string, string>([['main', C1]]),
};
const notFound = () => { throw new Error('GitHub API error: 404 {"message":"Not Found"}'); };
const real = await import('../../src/lib/github');
mock.module('../../src/lib/github', () => ({
  ...real,
  githubApi: async (_installationId: number, path: string) => {
    const commit = /^\/repos\/acme\/shop\/git\/commits\/([^/?]+)$/.exec(path);
    if (commit) return world.commits.has(commit[1]) ? { sha: commit[1] } : notFound();
    const contents = /^\/repos\/acme\/shop\/contents\/(.+)\?ref=(.+)$/.exec(path);
    if (!contents) return notFound();
    const ref = decodeURIComponent(contents[2]);
    const sha = world.branches.get(ref) ?? ref;
    const text = world.commits.get(sha)?.[decodeURIComponent(contents[1])];
    if (text === undefined) return notFound();
    return { type: 'file', size: Buffer.byteLength(text), encoding: 'base64', content: Buffer.from(text).toString('base64') };
  },
}));

const { createSpecDraft, reviseSpecDraft, getSpec, readSpecRepoRef } = await import('../../src/lib/specs/store');

const rand = () => Math.random().toString(36).slice(2, 10);
async function member(teamId: string) {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, 'member')`);
  return u.id;
}
/** Link the workspace to acme/shop through the GitHub App, the way an installation sync does. */
async function linkRepo(workspaceId: string) {
  const instId = Math.floor(Math.random() * 1e9);
  const [inst] = await q<{ id: string }>(sql`INSERT INTO github_installations (installation_id, account_type, account_login, account_id) VALUES (${instId}, 'Organization', 'acme', ${instId}) RETURNING id`);
  const [repo] = await q<{ id: string }>(sql`INSERT INTO github_repos (installation_id, repo_id, full_name, name, owner) VALUES (${inst.id}::uuid, ${instId}, 'acme/shop', 'shop', 'acme') RETURNING id`);
  await q(sql`UPDATE workspaces SET github_repo_id = ${repo.id}::uuid WHERE id = ${workspaceId}::uuid`);
}
const counts = async (workspaceId: string) => (await q<{ specs: number; arts: number }>(sql`
  SELECT (SELECT count(*)::int FROM specs WHERE workspace_id = ${workspaceId}::uuid) AS specs,
         (SELECT count(*)::int FROM artifacts WHERE workspace_id = ${workspaceId}::uuid) AS arts`))[0];

let wsA: string; let userA: string; let wsB: string; let userB: string; let wsText: string; let userText: string;
beforeAll(async () => {
  assertDbConfigured();
  let teamA: string; let teamB: string; let teamText: string;
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  ({ teamId: teamB, workspaceId: wsB } = await seedWorkspace());
  ({ teamId: teamText, workspaceId: wsText } = await seedWorkspace());
  for (const ws of [wsA, wsB, wsText]) await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${ws}::uuid`);
  await linkRepo(wsA);
  await linkRepo(wsB);
  // Only the free-text column names the repo: not a trustworthy identity.
  await q(sql`UPDATE workspaces SET repo = 'https://github.com/acme/shop' WHERE id = ${wsText}::uuid`);
  userA = await member(teamA);
  userB = await member(teamB);
  userText = await member(teamText);
});
const as = (userId: string) => ({ kind: 'user' as const, userId });
const read = (userId: string, specId: string, opts: { revision?: number; path?: string; view?: string; grep?: string } = {}) =>
  readSpecRepoRef(as(userId), specId, {
    revision: opts.revision, path: opts.path ?? PATH,
    selector: () => (opts.view === 'grep' ? { view: 'grep', pattern: opts.grep ?? '' } : opts.view === 'outline' ? { view: 'outline' } : { view: 'full' }),
  });

async function draftCiting(commitSha: string) {
  const r = await createSpecDraft(as(userA), { workspaceId: wsA, title: `Checkout ${rand()}`, body: 'R-1: follow the repo spec.', repoRefs: [{ path: PATH, commitSha }] });
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe('a revision cites a repo spec at an exact commit', () => {
  test('the reference keeps returning that commit text after the branch moves', async () => {
    world.branches.set('main', C1);
    const { spec, revision } = await draftCiting(C1);
    expect(revision.repoRefs).toEqual([{ path: PATH, commitSha: C1 }]);
    const before = await read(userA, spec.id);
    expect(before.ok && before.read.view === 'full' && before.read.text).toBe(V1);

    world.branches.set('main', C2);
    const after = await read(userA, spec.id);
    expect(after.ok && after.read.view === 'full' && after.read.text).toBe(V1);
    world.branches.set('main', C1);
  });

  test('get returns the references; reads are bounded like artifact reads', async () => {
    const { spec } = await draftCiting(C1);
    const got = await getSpec(as(userA), spec.id);
    expect(got.ok && got.view.revision.repoRefs).toEqual([{ path: PATH, commitSha: C1 }]);
    const grep = await read(userA, spec.id, { view: 'grep', grep: 'hourly' });
    expect(grep.ok && grep.read.view === 'grep' && grep.read.matches.map((m) => m.text)).toEqual(['Rates refresh hourly.']);
    const outline = await read(userA, spec.id, { view: 'outline' });
    expect(outline.ok && outline.read.view === 'outline' && outline.read.sections.map((s) => s.title)).toEqual(['Checkout', 'Totals', 'Rates']);
  });

  test('a revise can move the reference to a newer commit; the earlier revision still reads its own commit', async () => {
    const { spec } = await draftCiting(C1);
    const r = await reviseSpecDraft(as(userA), spec.id, { expectedVersion: 1, body: 'R-1: follow the repo spec.', repoRefs: [{ path: PATH, commitSha: C2 }] });
    expect(r.ok && [r.unchanged, r.revision.revision, r.revision.repoRefs]).toEqual([false, 2, [{ path: PATH, commitSha: C2 }]]);
    // Only the reference changed: the new revision pins the same body.
    const v1 = await getSpec(as(userA), spec.id, { revision: 1 });
    expect(r.ok && v1.ok && r.revision.contentHash).toBe(v1.ok ? v1.view.revision.contentHash : '');
    const r2 = await read(userA, spec.id);
    const r1 = await read(userA, spec.id, { revision: 1 });
    expect([r2.ok && r2.read.view === 'full' && r2.read.text, r1.ok && r1.read.view === 'full' && r1.read.text]).toEqual([V2, V1]);
  });

  test('a revise without repoRefs carries the head references forward; [] clears them', async () => {
    const { spec } = await draftCiting(C1);
    const kept = await reviseSpecDraft(as(userA), spec.id, { expectedVersion: 1, body: 'R-1: follow the repo spec, v2.' });
    expect(kept.ok && kept.revision.repoRefs).toEqual([{ path: PATH, commitSha: C1 }]);
    const same = await reviseSpecDraft(as(userA), spec.id, { expectedVersion: 2, body: 'R-1: follow the repo spec, v2.' });
    expect(same.ok && same.unchanged).toBe(true);
    const cleared = await reviseSpecDraft(as(userA), spec.id, { expectedVersion: 2, body: 'R-1: follow the repo spec, v2.', repoRefs: [] });
    expect(cleared.ok && [cleared.unchanged, cleared.revision.repoRefs]).toEqual([false, null]);
  });
});

describe('a reference that does not resolve is refused, and nothing is written', () => {
  test('a path missing at the commit, or a commit the repo does not have', async () => {
    for (const ref of [{ path: 'docs/specs/nope.md', commitSha: C1 }, { path: PATH, commitSha: UNKNOWN }]) {
      const before = await counts(wsA);
      const r = await createSpecDraft(as(userA), { workspaceId: wsA, title: 'Bad ref', body: 'R-1: x', repoRefs: [ref] });
      expect(!r.ok && [r.status, r.error.includes('nothing was written')]).toEqual([400, true]);
      expect(await counts(wsA)).toEqual(before);
    }
  });

  test('a branch name or a short SHA is never accepted as a commit', async () => {
    for (const commitSha of ['main', C1.slice(0, 12)]) {
      const r = await createSpecDraft(as(userA), { workspaceId: wsA, title: 'Branch ref', body: 'R-1: x', repoRefs: [{ path: PATH, commitSha }] });
      expect(!r.ok && r.status).toBe(400);
    }
  });

  test('a revise with a bad reference leaves the spec, its revisions and its body as they were', async () => {
    const { spec } = await draftCiting(C1);
    const r = await reviseSpecDraft(as(userA), spec.id, { expectedVersion: 1, body: 'R-1: changed body.', repoRefs: [{ path: 'docs/specs/nope.md', commitSha: C2 }] });
    expect(!r.ok && r.status).toBe(400);
    const got = await getSpec(as(userA), spec.id);
    expect(got.ok && [got.view.spec.version, got.view.revisions.length, got.view.body]).toEqual([1, 1, 'R-1: follow the repo spec.']);
  });

  test('a workspace whose repo is only named in free text cannot cite it', async () => {
    const r = await createSpecDraft(as(userText), { workspaceId: wsText, title: 'Text repo', body: 'R-1: x', repoRefs: [{ path: PATH, commitSha: C1 }] });
    expect(!r.ok && [r.status, r.error]).toEqual([400, expect.stringContaining('no GitHub repo linked')]);
  });
});

describe('only what a revision cites, and only in its own workspace', () => {
  test('another workspace cannot read the reference', async () => {
    const { spec } = await draftCiting(C1);
    const r = await read(userB, spec.id);
    expect(!r.ok && r.status).toBe(404);
    const agentB = { kind: 'account' as const, account: { id: '00000000-0000-4000-8000-0000000000b2', teamId: 'x', workspaceIds: null, taskScope: { workspaceId: wsB } } as any };
    const viaToken = await readSpecRepoRef(agentB, spec.id, { path: PATH, selector: () => null });
    expect(!viaToken.ok && viaToken.status).toBe(404);
  });

  test('a path the revision does not cite is not readable, even if it exists in the repo', async () => {
    world.commits.get(C1)!['docs/specs/other.md'] = 'secret-ish';
    const { spec } = await draftCiting(C1);
    const r = await read(userA, spec.id, { path: 'docs/specs/other.md' });
    expect(!r.ok && [r.status, r.error]).toEqual([404, `Revision 1 does not cite docs/specs/other.md`]);
    const escape = await read(userA, spec.id, { path: '../etc/passwd' });
    expect(!escape.ok && escape.status).toBe(400);
  });
});
