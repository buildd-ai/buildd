/**
 * Retiring a spec reaches the repo file that stands for it (living-specs.md
 * §22, R-78 to R-80, AC-124 to AC-126), against real Postgres with a fake
 * GitHub that records every call: one PR marks an imported source file
 * superseded (body untouched) or removes a generated copy; an import run lists
 * a deleted or superseded file under Retire and only a person's confirmation
 * retires it; restore opens nothing and says the file still reads superseded.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

process.env.AUTH_SECRET ||= 'spec-retire-repo-file-test-secret';

const { createSpecDraft } = await import('../../src/lib/specs/store');
const { specApprovalDeps } = await import('../../src/lib/specs/approval');
const { organizeDeps } = await import('../../src/lib/specs/organize');
const { importRepoSpecs, confirmImportedSpecs } = await import('../../src/lib/specs/import');
const { retireSpec, restoreSpec, specRetirement, specRestoredRepoFile, retireDeps } = await import('../../src/lib/specs/retire');
const { landRetirementPr, settleRetirementPr } = await import('../../src/lib/specs/retire-repo-file');
const { specShortId } = await import('@buildd/spec-contract/repo-copy');
const { markSpecSuperseded, parseSpecFrontmatter } = await import('@buildd/spec-contract/repo-spec');

const REPO = join(import.meta.dir, '../../../..');
const rand = () => Math.random().toString(36).slice(2, 10);
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');

const spec = (title: string, extra = '') => `---
title: ${title}
status: draft
owner: someone
last_verified: 2026-10-01
summary: ${title} MUST hold.
domain: tasks
${extra}---
# ${title}

- R-1: ${title} holds for every widget.
`;

/**
 * A fake GitHub: one repo whose docs/specs the test edits (each edit a new
 * commit), the reads import and the PR writer make, and every call it saw.
 */
function fakeGitHub(files: Record<string, string>) {
  const GH = `acme/app-${rand()}`;
  const checkSpecs = readFileSync(join(REPO, 'scripts/check-specs.ts'), 'utf8');
  const state = { commit: hex(40), files: new Map(Object.entries(files).map(([n, t]) => [n, { text: t, oid: hex(40) }])), lastTouch: new Map<string, string>() };
  const snapshots = new Map([[state.commit, new Map(state.files)]]);
  const calls: Array<{ method: string; path: string; body: any }> = [];
  let nextPr = 900 + Math.floor(Math.random() * 1000);
  const prs = new Map<number, { head: string; branch: string; open: boolean }>();
  const refs = new Map<string, string>();
  const newCommit = () => { state.commit = hex(40); snapshots.set(state.commit, new Map(state.files)); return state.commit; };
  const api = async (_inst: number, path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    if (method === 'GET' && path === `/repos/${GH}`) return { default_branch: 'dev', private: true };
    if (method === 'GET' && path === `/repos/${GH}/commits/dev`) return { sha: state.commit };
    if (method === 'GET' && path === `/repos/${GH}/git/ref/heads/dev`) return { object: { sha: state.commit } };
    if (method === 'GET' && path.startsWith(`/repos/${GH}/git/commits/`)) return { tree: { sha: `tree-${path.split('/').pop()}` } };
    if (method === 'POST' && path === '/graphql') {
      const query: string = body.query;
      if (query.includes('history(')) {
        const commit: Record<string, unknown> = {};
        for (const m of query.matchAll(/(f\d+): history\(first: 1, path: ("[^"]+")\)/g)) {
          const p = JSON.parse(m[2]!) as string;
          commit[m[1]!] = { nodes: [{ oid: state.lastTouch.get(p) ?? hex(40), associatedPullRequests: { nodes: [] } }] };
        }
        return { data: { repository: { commit } } };
      }
      const at = String(body.variables?.specs ?? '').split(':')[0]!;
      const snap = snapshots.get(at);
      if (!snap) throw new Error(`fake GitHub: no commit ${at}`);
      return { data: { repository: {
        specs: { entries: [...snap].map(([name, f]) => ({ name, type: 'blob', oid: f.oid, object: { text: f.text } })) },
        script: { text: checkSpecs },
      } } };
    }
    if (method === 'POST' && path === `/repos/${GH}/git/trees`) return { sha: `t${calls.length}` };
    if (method === 'POST' && path === `/repos/${GH}/git/commits`) return { sha: hex(40) };
    if (method === 'PATCH' && path.startsWith(`/repos/${GH}/git/refs/heads/`)) {
      const branch = decodeURIComponent(path.slice(`/repos/${GH}/git/refs/heads/`.length));
      if (!refs.has(branch)) throw new Error('GitHub API error: 422 Reference does not exist');
      refs.set(branch, body.sha); return {};
    }
    if (method === 'POST' && path === `/repos/${GH}/git/refs`) { refs.set(String(body.ref).replace('refs/heads/', ''), body.sha); return {}; }
    if (method === 'GET' && path.startsWith(`/repos/${GH}/pulls?`)) {
      const head = decodeURIComponent(new URL(`https://x${path}`).searchParams.get('head') ?? '').split(':')[1];
      return [...prs].filter(([, p]) => p.open && p.branch === head).map(([number]) => ({ number }));
    }
    if (method === 'POST' && path === `/repos/${GH}/pulls`) { const n = nextPr++; prs.set(n, { head: refs.get(body.head)!, branch: body.head, open: true }); return { number: n }; }
    const pr = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)(\/merge)?$/.exec(path);
    if (pr && method === 'GET') { const p = prs.get(Number(pr[1])); return { state: p?.open ? 'open' : 'closed', head: { sha: p ? refs.get(p.branch) : null } }; }
    if (pr && method === 'PATCH') return {};
    if (pr && pr[2] && method === 'PUT') { prs.get(Number(pr[1]))!.open = false; return { merged: true }; }
    if (method === 'GET' && path.endsWith('/check-suites')) return { check_suites: [{ status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }] };
    throw new Error(`fake GitHub: unexpected ${method} ${path}`);
  };
  return {
    GH, state, calls,
    deps: { api, repo: async () => ({ fullName: GH, installationId: 1 }), now: () => new Date('2026-10-23T12:00:00Z'), duplicates: false as const },
    edit(name: string, text: string) { state.files.set(name, { text, oid: hex(40) }); return newCommit(); },
    remove(name: string) { state.files.delete(name); const c = newCommit(); state.lastTouch.set(`docs/specs/${name}`, c); return c; },
    text: (name: string) => state.files.get(name)?.text,
    prsOpened: () => calls.filter((c) => c.method === 'POST' && c.path === `/repos/${GH}/pulls`),
    writes: () => calls.filter((c) => c.method !== 'GET' && c.path !== '/graphql'),
    treeOf: (n: number) => calls.filter((c) => c.method === 'POST' && c.path === `/repos/${GH}/git/trees`)[n]?.body.tree as Array<{ path: string; content?: string; sha?: null }>,
    headOf: (n: number) => refs.get(prs.get(n)!.branch)!,
  };
}

async function person(teamId: string, role: 'owner' | 'admin' | 'member') {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, ${role})`);
  return u.id;
}
const user = (userId: string) => ({ kind: 'user' as const, userId });
const ACCOUNT = '00000000-0000-4000-8000-0000000000b9';

let teamA: string; let admin: string; let member: string;
const queued: Array<() => Promise<unknown>> = [];
const runQueued = async () => { for (const t of queued.splice(0)) await t(); };
const agentToken = (w: string) => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId: teamA, workspaceIds: null, taskScope: { taskId: '00000000-0000-4000-8000-0000000000f9', workspaceId: w } } as any });

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA } = await seedWorkspace());
  admin = await person(teamA, 'admin');
  member = await person(teamA, 'member');
  specApprovalDeps.afterResponse = (task) => { queued.push(task); };
  retireDeps.afterResponse = (task) => { queued.push(task); };
  organizeDeps.classify = async () => ({ ran: false, reason: 'no decision model in this test' });
  organizeDeps.suggest = async () => null;
});

async function freshWs() {
  const w = (await seedWorkspace()).workspaceId;
  await q(sql`UPDATE workspaces SET team_id = ${teamA}::uuid, access_mode = 'open' WHERE id = ${w}::uuid`);
  return w;
}
async function ok<T>(p: Promise<{ ok: true; result: T } | { ok: false; error: string }>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(r.error);
  return r.result;
}
async function imported(w: string, gh: ReturnType<typeof fakeGitHub>) {
  const r = await ok(importRepoSpecs(user(member), { workspaceId: w, dryRun: false }, gh.deps));
  queued.length = 0;
  return Object.fromEntries(r.files.filter((f) => f.specId).map((f) => [f.path.slice('docs/specs/'.length), f.specId!]));
}
const statusOf = async (id: string) => (await q<{ status: string }>(sql`SELECT status FROM specs WHERE id = ${id}::uuid`))[0]!.status;
const REASON = 'Replaced by the newer widget contract.';

describe('AC-124: superseding an imported spec opens one PR on its source file', () => {
  test('one PR sets status and superseded_by in the frontmatter, the body untouched; the page names it until it merges; the next import skips the file', async () => {
    const w = await freshWs();
    const gh = fakeGitHub({ 'a.md': spec('Alpha'), 'b.md': spec('Beta'), 'INDEX.md': '<!-- GENERATED -->\n# Spec Index\n' });
    const ids = await imported(w, gh);
    retireDeps.repoFile = gh.deps;
    const before = gh.writes().length;

    const r = await retireSpec(user(admin), ids['a.md']!, { reason: REASON, supersededBy: ids['b.md'] });
    if (!r.ok) throw new Error(r.error);
    await runQueued();

    expect(gh.prsOpened()).toHaveLength(1);
    const pr = gh.prsOpened()[0]!;
    expect(pr.body.title).toContain('a.md');
    const tree = gh.treeOf(0);
    const a = tree.find((f) => f.path === 'docs/specs/a.md')!;
    expect(a.content).toBe(markSpecSuperseded(spec('Alpha'), 'b'));
    expect(parseSpecFrontmatter(a.content!).body).toBe(parseSpecFrontmatter(spec('Alpha')).body);
    expect(parseSpecFrontmatter(a.content!).fm).toMatchObject({ status: 'superseded', superseded_by: 'b' });
    expect(tree.map((f) => f.path).sort()).toEqual(['docs/specs/INDEX.md', 'docs/specs/a.md']);
    expect(tree.find((f) => f.path === 'docs/specs/INDEX.md')!.content).toContain('## Superseded (1)');

    const view = await specRetirement(ids['a.md']!);
    expect(view?.repoFile).toMatchObject({ kind: 'source', path: 'docs/specs/a.md', state: 'open', repoFullName: gh.GH });
    const prNumber = view!.repoFile!.prNumber!;
    expect(view?.repoLine?.text).toContain(`#${prNumber}`);
    expect(view?.repoLine?.href).toBe(`https://github.com/${gh.GH}/pull/${prNumber}`);

    // Retiring again is refused, so it cannot open a second PR.
    expect(await retireSpec(user(admin), ids['a.md']!, { reason: REASON })).toMatchObject({ ok: false, status: 409 });

    // The person merges it on GitHub.
    gh.edit('a.md', a.content!);
    await settleRetirementPr({ repoFullName: gh.GH, prNumber, merged: true });
    const merged = await specRetirement(ids['a.md']!);
    expect(merged?.repoFile?.state).toBe('merged');
    expect(merged?.repoLine).toBeNull();

    const next = await ok(importRepoSpecs(user(member), { workspaceId: w }, gh.deps));
    expect(next.files.find((f) => f.path === 'docs/specs/a.md')).toMatchObject({ action: 'skip', reason: 'superseded' });
    expect(next.counts.retire).toBe(0);
    expect(gh.prsOpened()).toHaveLength(1);
    expect(gh.writes().length).toBeGreaterThan(before);
  });

  test('retired with nothing replacing it, the file says superseded_by: none; a replacement with no repo file is named by its short id', async () => {
    const w = await freshWs();
    const gh = fakeGitHub({ 'c.md': spec('Gamma'), 'd.md': spec('Delta') });
    const ids = await imported(w, gh);
    retireDeps.repoFile = gh.deps;
    const native = await createSpecDraft(user(member), { workspaceId: w, title: `Native ${rand()}`, body: `# Native\nR-1: native ${rand()}.\n` }, { duplicates: false });
    if (!native.ok) throw new Error(native.error);

    await retireSpec(user(admin), ids['c.md']!, { reason: REASON });
    await retireSpec(user(admin), ids['d.md']!, { reason: REASON, supersededBy: native.spec.id });
    await runQueued();
    expect(gh.prsOpened()).toHaveLength(2);
    const c = gh.treeOf(0).find((f) => f.path === 'docs/specs/c.md')!;
    const d = gh.treeOf(1).find((f) => f.path === 'docs/specs/d.md')!;
    expect(parseSpecFrontmatter(c.content!).fm?.superseded_by).toBe('none');
    expect(parseSpecFrontmatter(d.content!).fm?.superseded_by).toBe(`buildd:${specShortId(native.spec.id)}`);
  });

  test('a spec no repo file stands for opens nothing', async () => {
    const w = await freshWs();
    const gh = fakeGitHub({});
    retireDeps.repoFile = gh.deps;
    const native = await createSpecDraft(user(member), { workspaceId: w, title: `Native ${rand()}`, body: `# Native\nR-1: native ${rand()}.\n` }, { duplicates: false });
    if (!native.ok) throw new Error(native.error);
    await retireSpec(user(admin), native.spec.id, { reason: REASON });
    await runQueued();
    expect(gh.calls).toEqual([]);
  });
});

describe('R-78: a generated copy is removed under the generated-copy exception', () => {
  test('one PR deletes the copy and updates the index; it lands on green CI only at the generator\'s head', async () => {
    const w = await freshWs();
    const s = await createSpecDraft(user(member), { workspaceId: w, title: `Widget Exports ${rand()}`, body: '# Widget Exports\n- AC-1: one file.\n' }, { duplicates: false });
    if (!s.ok) throw new Error(s.error);
    const short = specShortId(s.spec.id);
    const copy = `---\ntitle: Widget Exports\nstatus: active\nsummary: Widget exports MUST write one file.\ndomain: tasks\ngenerated_from: ${short}@r1\n---\n# Widget Exports\n`;
    const gh = fakeGitHub({ 'widget-exports.md': copy, 'other.md': spec('Other'), 'INDEX.md': '# Spec Index\n' });
    await q(sql`UPDATE specs SET repo_copy = ${JSON.stringify({ state: 'merged', path: 'docs/specs/widget-exports.md', repoFullName: gh.GH, updatedAt: new Date().toISOString() })}::jsonb WHERE id = ${s.spec.id}::uuid`);
    retireDeps.repoFile = gh.deps;

    await retireSpec(user(admin), s.spec.id, { reason: REASON });
    await runQueued();
    expect(gh.prsOpened()).toHaveLength(1);
    const tree = gh.treeOf(0);
    expect(tree.find((f) => f.path === 'docs/specs/widget-exports.md')).toMatchObject({ sha: null });
    const index = tree.find((f) => f.path === 'docs/specs/INDEX.md')!;
    expect(index.content).toContain('other.md');
    expect(index.content).not.toContain('widget-exports.md');
    expect(gh.prsOpened()[0]!.body.body).toContain('generated-spec-copy');

    const view = await specRetirement(s.spec.id);
    expect(view?.repoFile).toMatchObject({ kind: 'copy', state: 'open' });
    const n = view!.repoFile!.prNumber!;
    // A head the generator did not write never lands under the exception.
    expect(await landRetirementPr({ repoFullName: gh.GH, prNumber: n, headSha: hex(40), conclusion: 'success', installationId: 1 }, gh.deps)).toMatchObject({ outcome: 'stale' });
    const landed = await landRetirementPr({ repoFullName: gh.GH, prNumber: n, headSha: gh.headOf(n), conclusion: 'success', installationId: 1 }, gh.deps);
    expect(landed).toMatchObject({ specId: s.spec.id, outcome: 'merged' });
    expect(gh.calls.some((c) => c.method === 'PUT' && c.path.endsWith(`/pulls/${n}/merge`) && c.body.sha === gh.headOf(n))).toBe(true);
    expect((await specRetirement(s.spec.id))?.repoFile?.state).toBe('merged');
    // Any other PR is not a retirement PR.
    expect(await landRetirementPr({ repoFullName: gh.GH, prNumber: n + 1, headSha: 'x', conclusion: 'success', installationId: 1 }, gh.deps)).toBeNull();
  });

  test('a source-file PR never lands on its own', async () => {
    const w = await freshWs();
    const gh = fakeGitHub({ 'e.md': spec('Epsilon') });
    const ids = await imported(w, gh);
    retireDeps.repoFile = gh.deps;
    await retireSpec(user(admin), ids['e.md']!, { reason: REASON });
    await runQueued();
    const n = (await specRetirement(ids['e.md']!))!.repoFile!.prNumber!;
    expect(await landRetirementPr({ repoFullName: gh.GH, prNumber: n, headSha: gh.headOf(n), conclusion: 'success', installationId: 1 }, gh.deps)).toBeNull();
    expect(gh.calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

describe('AC-126: restore opens nothing', () => {
  test('restoring a spec retired through its file opens no PR and says the repo file still reads superseded', async () => {
    const w = await freshWs();
    const gh = fakeGitHub({ 'f.md': spec('Phi') });
    const ids = await imported(w, gh);
    retireDeps.repoFile = gh.deps;
    await retireSpec(user(admin), ids['f.md']!, { reason: REASON });
    await runQueued();
    expect(gh.prsOpened()).toHaveLength(1);
    expect(await specRestoredRepoFile(ids['f.md']!)).toBeNull();
    const writes = gh.writes().length;

    const back = await restoreSpec(user(admin), ids['f.md']!, {});
    if (!back.ok) throw new Error(back.error);
    await runQueued();
    expect(gh.writes()).toHaveLength(writes);
    expect(gh.prsOpened()).toHaveLength(1);
    expect(await specRestoredRepoFile(ids['f.md']!)).toMatch(/docs\/specs\/f\.md still reads superseded/);
  });
});

describe('AC-125 / R-79: import lists retirements a person confirms', () => {
  test('a deleted file: the dry run lists it under Retire with the commit and writes nothing; confirming retires it and opens no PR', async () => {
    const w = await freshWs();
    const gh = fakeGitHub({ 'g.md': spec('Gee'), 'h.md': spec('Aitch') });
    const ids = await imported(w, gh);
    retireDeps.repoFile = gh.deps;
    const removedIn = gh.remove('g.md');
    const writes = gh.writes().length;

    for (const dryRun of [true, false]) {
      const r = await ok(importRepoSpecs(user(member), { workspaceId: w, dryRun }, gh.deps));
      const row = r.files.find((f) => f.path === 'docs/specs/g.md')!;
      expect(row).toMatchObject({ action: 'retire', specId: ids['g.md'], retire: { why: 'removed', status: 'retired', removedIn } });
      expect(row.message).toBe(`file removed in ${removedIn.slice(0, 7)}`);
      expect(r.counts.retire).toBe(1);
      expect(await statusOf(ids['g.md']!)).toBe('draft');
    }
    expect(gh.writes()).toHaveLength(writes);

    // An agent never confirms.
    expect(await confirmImportedSpecs(agentToken(w), { workspaceId: w, specIds: [ids['g.md']!] }, gh.deps)).toMatchObject({ ok: false, status: 403 });
    expect(await statusOf(ids['g.md']!)).toBe('draft');

    const c = await ok(confirmImportedSpecs(user(admin), { workspaceId: w, specIds: [ids['g.md']!] }, gh.deps));
    expect(c.retired).toEqual([expect.objectContaining({ specId: ids['g.md'], status: 'retired', path: 'docs/specs/g.md' })]);
    expect(c.confirmed).toEqual([]);
    expect(await statusOf(ids['g.md']!)).toBe('retired');
    expect((await specRetirement(ids['g.md']!))?.reason).toBe(`file removed in ${removedIn.slice(0, 7)}`);
    await runQueued();
    expect(gh.prsOpened()).toEqual([]);
    expect(gh.writes()).toHaveLength(writes);

    // Retired now: the next import lists nothing for it.
    const after = await ok(importRepoSpecs(user(member), { workspaceId: w }, gh.deps));
    expect(after.files.find((f) => f.path === 'docs/specs/g.md')).toBeUndefined();
    expect(after.counts.retire).toBe(0);
  });

  test('a file marked superseded by another imported file: listed as superseded by that spec; confirming supersedes it', async () => {
    const w = await freshWs();
    const gh = fakeGitHub({ 'old-flow.md': spec('Old Flow'), 'new-flow.md': spec('New Flow') });
    const ids = await imported(w, gh);
    retireDeps.repoFile = gh.deps;
    gh.edit('old-flow.md', markSpecSuperseded(spec('Old Flow'), 'new-flow')!);

    const dry = await ok(importRepoSpecs(user(member), { workspaceId: w }, gh.deps));
    const row = dry.files.find((f) => f.path === 'docs/specs/old-flow.md')!;
    expect(row).toMatchObject({ action: 'retire', specId: ids['old-flow.md'], retire: { why: 'marked_superseded', status: 'superseded', supersededBy: { specId: ids['new-flow.md'], title: 'New Flow' } } });
    expect(row.message).toBe('marked superseded by New Flow');

    const c = await ok(confirmImportedSpecs(user(admin), { workspaceId: w, specIds: [ids['old-flow.md']!, ids['new-flow.md']!] }, gh.deps));
    expect(c.retired.map((x) => [x.specId, x.status])).toEqual([[ids['old-flow.md'], 'superseded']]);
    expect(c.confirmed.map((x) => x.specId)).toEqual([ids['new-flow.md']]);
    expect((await specRetirement(ids['old-flow.md']!))?.supersededBy?.id).toBe(ids['new-flow.md']);
    await runQueued();
    expect(gh.prsOpened()).toEqual([]);

    // Restoring it opens nothing either, and says the file still reads superseded (R-80).
    await restoreSpec(user(admin), ids['old-flow.md']!, {});
    await runQueued();
    expect(gh.prsOpened()).toEqual([]);
    expect(await specRestoredRepoFile(ids['old-flow.md']!)).toMatch(/still reads superseded/);
  });

  test('a replacement buildd cannot match: retired, not superseded', async () => {
    const w = await freshWs();
    const gh = fakeGitHub({ 'lone.md': spec('Lone') });
    const ids = await imported(w, gh);
    gh.edit('lone.md', markSpecSuperseded(spec('Lone'), 'somewhere-else')!);
    const dry = await ok(importRepoSpecs(user(member), { workspaceId: w }, gh.deps));
    expect(dry.files[0]).toMatchObject({ action: 'retire', retire: { status: 'retired', supersededBy: null } });
    expect(dry.files[0]!.message).toBe('marked superseded by somewhere-else');
    const c = await ok(confirmImportedSpecs(user(admin), { workspaceId: w, specIds: [ids['lone.md']!] }, gh.deps));
    expect(c.retired.map((x) => x.status)).toEqual(['retired']);
  });
});

describe('a spec superseded by hand whose file is then marked superseded (Claim Overlap Scheduling)', () => {
  test('the import skips it, confirm skips it, and no second PR is opened', async () => {
    const w = await freshWs();
    const gh = fakeGitHub({ 'claim-overlap-scheduling.md': spec('Claim Overlap Scheduling'), 'task-dispatch.md': spec('Task Dispatch') });
    const ids = await imported(w, gh);
    const id = ids['claim-overlap-scheduling.md']!;
    // Superseded by hand before buildd wrote repo files: nothing ran after it.
    retireDeps.repoFile = undefined;
    await retireSpec(user(admin), id, { reason: REASON, supersededBy: ids['task-dispatch.md'] });
    queued.length = 0;
    // Another mission's docs task marks the file.
    gh.edit('claim-overlap-scheduling.md', markSpecSuperseded(spec('Claim Overlap Scheduling'), 'task-dispatch')!);
    const writes = gh.writes().length;

    for (const dryRun of [true, false]) {
      const r = await ok(importRepoSpecs(user(member), { workspaceId: w, dryRun }, gh.deps));
      expect(r.files.find((f) => f.path === 'docs/specs/claim-overlap-scheduling.md')).toMatchObject({ action: 'skip', reason: 'superseded', specId: id });
      expect(r.counts.retire).toBe(0);
    }
    const c = await ok(confirmImportedSpecs(user(admin), { workspaceId: w, specIds: [id] }, gh.deps));
    expect(c.skipped.map((x) => x.reason)).toEqual(['retired']);
    expect(c.retired).toEqual([]);

    // Even if the PR writer runs for it now, the file already reads superseded: no PR.
    const { openRetirementPr } = await import('../../src/lib/specs/retire-repo-file');
    await openRetirementPr(id, gh.deps);
    expect(gh.prsOpened()).toEqual([]);
    expect(gh.writes()).toHaveLength(writes);
    expect(await statusOf(id)).toBe('superseded');
  });
});
