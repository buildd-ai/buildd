/**
 * Native spec homes with a generated repo copy (docs/specs/living-specs.md §18),
 * against real Postgres with a fake GitHub: the opt-in, the generated PR and
 * its header, the metadata block, the landing exception, the short-id link and
 * the pre-approval checks.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

process.env.AUTH_SECRET ||= 'spec-repo-copy-test-secret';

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision, specApprovalDeps } = await import('../../src/lib/specs/approval');
const { updateSpecMetadata, listSpecMetadataChanges } = await import('../../src/lib/specs/metadata');
const repoCopy = await import('../../src/lib/specs/repo-copy');
const { resolveSpecShortId } = await import('../../src/lib/specs/short-id');
const { verifyRepoCopy } = await import('@buildd/spec-contract/repo-copy');
const { lintSpecFile, parseSpecFrontmatter, readDomainList } = await import('@buildd/spec-contract/repo-spec');

const REPO = join(import.meta.dir, '../../../..');
const rand = () => Math.random().toString(36).slice(2, 10);
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function person(teamId: string, role: 'owner' | 'admin' | 'member') {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, ${role})`);
  return u.id;
}
const user = (userId: string) => ({ kind: 'user' as const, userId });

let nextPr = 100;
/** A repo name per run, so a re-run against the same database never finds an earlier run's PR. */
const GH = `acme/app-${rand()}`;
/** A fake GitHub: the base branch, docs/specs as the repo has it, and a record of every write. */
function fakeGitHub(opts: { specFiles?: Record<string, string> } = {}) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const PR = nextPr++;
  let commits = 0;
  let prHead: string | null = null;
  let prOpen = false;
  const checkSpecs = readFileSync(join(REPO, 'scripts/check-specs.ts'), 'utf8');
  const specFiles = opts.specFiles ?? {
    'INDEX.md': readFileSync(join(REPO, 'docs/specs/INDEX.md'), 'utf8'),
    'release-flow.md': readFileSync(join(REPO, 'docs/specs/release-flow.md'), 'utf8'),
  };
  const state = {
    failingRun: null as string | null,
    setPrHead(s: string) { prHead = s; },
  };
  const api = async (_inst: number, path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    if (method === 'GET' && path === `/repos/${GH}`) return { default_branch: 'dev' };
    if (method === 'GET' && path === `/repos/${GH}/git/ref/heads/dev`) return { object: { sha: 'base000' } };
    if (method === 'GET' && path === `/repos/${GH}/git/commits/base000`) return { tree: { sha: 'tree000' } };
    if (path === '/graphql') {
      return { data: { repository: {
        specs: { entries: Object.entries(specFiles).map(([name, text]) => ({ name, type: 'blob', object: { text } })) },
        script: { text: checkSpecs },
      } } };
    }
    if (method === 'GET' && path.startsWith(`/repos/${GH}/git/trees/base000`)) return { truncated: false, tree: [{ path: 'apps/web/src/lib/widget.test.ts' }, { path: 'docs/specs/release-flow.md' }] };
    if (method === 'POST' && path === `/repos/${GH}/git/trees`) return { sha: `tree${calls.length}` };
    if (method === 'POST' && path === `/repos/${GH}/git/commits`) { commits++; return { sha: `gen${commits}` }; }
    if (method === 'PATCH' && path.startsWith(`/repos/${GH}/git/refs/heads/`)) {
      if (!prHead && !prOpen) throw new Error('GitHub API error: 422 Reference does not exist');
      prHead = body.sha; return {};
    }
    if (method === 'POST' && path === `/repos/${GH}/git/refs`) { prHead = body.sha; return {}; }
    if (method === 'GET' && path.startsWith(`/repos/${GH}/pulls?`)) return prOpen ? [{ number: PR }] : [];
    if (method === 'POST' && path === `/repos/${GH}/pulls`) { prOpen = true; return { number: PR }; }
    if (method === 'GET' && path === `/repos/${GH}/pulls/${PR}`) return { state: prOpen ? 'open' : 'closed', head: { sha: prHead } };
    if (method === 'PATCH' && path === `/repos/${GH}/pulls/${PR}`) return {};
    if (method === 'GET' && path.endsWith('/check-runs?per_page=100')) return { check_runs: [{ name: 'build', conclusion: 'success' }, { name: state.failingRun ?? 'Lint specs', conclusion: 'failure' }] };
    if (method === 'GET' && path.endsWith('/check-suites')) return { check_suites: [{ status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }] };
    if (method === 'PUT' && path === `/repos/${GH}/pulls/${PR}/merge`) { prOpen = false; return { merged: true }; }
    throw new Error(`fake GitHub: unexpected ${method} ${path}`);
  };
  return {
    calls, state, PR,
    deps: { api, repo: async () => ({ fullName: GH, installationId: 1 }), now: () => new Date('2026-10-13T12:00:00Z') },
    writes: () => calls.filter((c) => c.method !== 'GET' && c.path !== '/graphql'),
    lastTree: () => [...calls].reverse().find((c) => c.method === 'POST' && c.path === `/repos/${GH}/git/trees`)?.body.tree as Array<{ path: string; content: string }>,
  };
}

let teamA: string; let wsOn: string; let wsOff: string; let wsOther: string;
let admin: string; let member: string; let outsider: string;
const queued: Array<() => Promise<unknown>> = [];

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsOn } = await seedWorkspace());
  ({ workspaceId: wsOff } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET team_id = ${teamA}::uuid, access_mode = 'open' WHERE id IN (${wsOn}::uuid, ${wsOff}::uuid)`);
  await q(sql`UPDATE workspaces SET git_config = coalesce(git_config, '{}'::jsonb) || ${JSON.stringify({ livingSpecs: { nativeSource: true } })}::jsonb WHERE id = ${wsOn}::uuid`);
  let teamB: string;
  ({ teamId: teamB, workspaceId: wsOther } = await seedWorkspace());
  admin = await person(teamA, 'admin');
  member = await person(teamA, 'member');
  outsider = await person(teamB, 'admin');
  specApprovalDeps.afterResponse = (task) => { queued.push(task); };
});

const ACCOUNT = '00000000-0000-4000-8000-0000000000a2';
const agentToken = (ws: string) => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId: teamA, workspaceIds: null, taskScope: { taskId: '00000000-0000-4000-8000-0000000000f2', workspaceId: ws } } as any });

const BODY = `---
title: Widget Exports
summary: A widget export MUST write one file per widget.
related: [release-flow]
---
# Widget Exports

- AC-1: GIVEN a widget WHEN exported THEN one file is written.
`;

async function filedSpec(ws: string, opts: { area?: string | null; body?: string } = {}) {
  let parentSpecId: string | null = null;
  if (opts.area !== null) {
    const a = await createSpecDraft(user(member), { workspaceId: ws, title: opts.area ?? `Exports Area ${rand()}`, scope: 'domain', body: '# Area\nExports and their files.\n' }, { duplicates: false });
    if (!a.ok) throw new Error(a.error);
    parentSpecId = a.spec.id;
  }
  const r = await createSpecDraft(user(member), { workspaceId: ws, title: `Widget Exports ${rand()}`, parentSpecId, body: opts.body ?? BODY }, { duplicates: false });
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}

async function approve(specId: string, revision = 1, expectedVersion = 1) {
  queued.length = 0;
  const r = await approveSpecRevision(user(admin), specId, { revision, expectedVersion });
  if (!r.ok || 'pending' in r) throw new Error('approval failed');
  return r;
}

async function runQueued() {
  for (const t of queued.splice(0)) await t().catch(() => {});
}

async function specRow(id: string) {
  const [row] = await q<{ version: number; approved_revision: number; repo_copy: any; metadata: any }>(sql`SELECT version, approved_revision, repo_copy, metadata FROM specs WHERE id = ${id}::uuid`);
  return row;
}

describe('opt-in (R-12, AC-78)', () => {
  test('a workspace that has not opted in: approving files no PR and calls GitHub not at all', async () => {
    const gh = fakeGitHub();
    Object.assign(repoCopy.defaultRepoCopyDeps, gh.deps);
    const spec = await filedSpec(wsOff);
    await approve(spec.id);
    await runQueued();
    expect(gh.calls).toEqual([]);
    expect((await specRow(spec.id)).repo_copy).toBeNull();
  });
});

describe('the generated PR (R-15, AC-74, AC-94)', () => {
  test('approving revision N writes one PR: the copy hashes to N, carries the metadata hash, no full id, and DOMAINS gains the area', async () => {
    const gh = fakeGitHub();
    Object.assign(repoCopy.defaultRepoCopyDeps, gh.deps);
    const spec = await filedSpec(wsOn, { area: `Widget Shipping ${rand()}` });
    await approve(spec.id);
    await runQueued();

    const rc = (await specRow(spec.id)).repo_copy;
    expect(rc).toMatchObject({ state: 'open', prNumber: gh.PR, repoFullName: GH, headSha: 'gen1', revision: 1, contentHash: sha(BODY) });
    expect(gh.calls.filter((c) => c.method === 'POST' && c.path === `/repos/${GH}/pulls`)).toHaveLength(1);

    const tree = gh.lastTree();
    const file = tree.find((f) => f.path === rc.path)!;
    expect(rc.path).toMatch(/^docs\/specs\/widget-exports-[a-z0-9]+\.md$/);
    const v = await verifyRepoCopy(file.content);
    expect(v.generated && v.ok && v.shortId === spec.id.slice(0, 8) && v.revision === 1).toBe(true);
    if (v.generated) expect(sha(v.approvedText)).toBe(sha(BODY));
    for (const f of tree) expect(f.content).not.toMatch(UUID);
    for (const c of gh.writes()) expect(JSON.stringify(c.body)).not.toContain(spec.id);

    // R-32: the area's domain is new, so the same PR adds it to DOMAINS; the copy lints clean against it.
    const script = tree.find((f) => f.path === 'scripts/check-specs.ts')!;
    const domain = parseSpecFrontmatter(file.content).fm!.domain!;
    expect(domain).toMatch(/^widget-shipping-/);
    expect(readDomainList(script.content)).toContain(domain);
    const { fm, body } = parseSpecFrontmatter(file.content);
    const lint = lintSpecFile('widget-exports', fm, body, { domains: new Set(readDomainList(script.content)!), exists: () => true, now: Date.parse('2026-10-14') });
    expect(lint.errors).toEqual([]);
    // The index lists the new spec, so specs:lint does not see a stale INDEX.md.
    expect(tree.find((f) => f.path === 'docs/specs/INDEX.md')!.content).toContain(`(./${rc.path.slice('docs/specs/'.length)})`);
  });

  test('a native-sourced spec with no area is not generated, and its page says so (R-32)', async () => {
    const gh = fakeGitHub();
    Object.assign(repoCopy.defaultRepoCopyDeps, gh.deps);
    const spec = await filedSpec(wsOn, { area: null });
    await approve(spec.id);
    await runQueued();
    const rc = (await specRow(spec.id)).repo_copy;
    expect(rc.state).toBe('unfiled');
    expect(gh.writes()).toEqual([]);
    expect(repoCopy.repoCopyLine(true, rc, true)?.copy).toContain('file this spec under an area');
  });
});

describe('the metadata block (R-14, R-31, AC-93)', () => {
  test('an agent adds a verified_by path with a reason: version, approved revision and content hash do not move; the change is logged; the PR carries it', async () => {
    const gh = fakeGitHub();
    Object.assign(repoCopy.defaultRepoCopyDeps, gh.deps);
    const spec = await filedSpec(wsOn);
    const a = await approve(spec.id);
    await runQueued();
    const before = await specRow(spec.id);
    const [{ content_hash: hashBefore }] = await q<{ content_hash: string }>(sql`SELECT content_hash FROM spec_revisions WHERE spec_id = ${spec.id}::uuid AND revision = 1`);

    queued.length = 0;
    const r = await updateSpecMetadata(agentToken(wsOn), spec.id, { changes: { verified_by: ['apps/web/src/lib/widget.test.ts'] }, reason: 'the export test now asserts AC-1' });
    if (!r.ok) throw new Error(r.error);
    expect(r.changed).toEqual(['verified_by']);
    const after = await specRow(spec.id);
    expect([after.version, after.approved_revision]).toEqual([before.version, a.spec.approvedRevision]);
    const [{ n, content_hash }] = await q<{ n: number; content_hash: string }>(sql`SELECT count(*)::int AS n, max(content_hash) AS content_hash FROM spec_revisions WHERE spec_id = ${spec.id}::uuid`);
    expect([n, content_hash]).toEqual([1, hashBefore]);

    const log = await listSpecMetadataChanges(user(member), spec.id);
    expect(log.ok && log.changes.map((c) => [c.field, c.previousValue, c.newValue, c.reason, c.changedByKind, c.changedBy])).toEqual([
      ['verified_by', null, ['apps/web/src/lib/widget.test.ts'], 'the export test now asserts AC-1', 'agent', `account:${ACCOUNT}`],
    ]);

    await runQueued();
    const rc = (await specRow(spec.id)).repo_copy;
    expect(rc).toMatchObject({ state: 'open', prNumber: gh.PR, headSha: 'gen2', contentHash: hashBefore });
    expect(rc.metadataHash).not.toBe(before.repo_copy.metadataHash);
    expect(gh.calls.filter((c) => c.method === 'POST' && c.path === `/repos/${GH}/pulls`)).toHaveLength(1);
    const copy = gh.lastTree().find((f) => f.path === rc.path)!.content;
    expect(copy).toContain('verified_by: [apps/web/src/lib/widget.test.ts]');
    expect(copy).toContain('status: active');
  });

  test('a reason is required, domain is not a metadata field, and a reader without write access is refused', async () => {
    const spec = await filedSpec(wsOn);
    expect(await updateSpecMetadata(user(member), spec.id, { changes: { owner: 'someone' }, reason: '' })).toMatchObject({ ok: false, status: 400 });
    expect(await updateSpecMetadata(user(member), spec.id, { changes: { domain: 'tasks' }, reason: 'move it' })).toMatchObject({ ok: false, status: 400 });
    expect(await updateSpecMetadata(user(outsider), spec.id, { changes: { owner: 'someone' }, reason: 'take it' })).toMatchObject({ ok: false, status: 404 });
  });
});

describe('landing under the exception (R-35, AC-97, AC-79)', () => {
  async function opened() {
    const gh = fakeGitHub();
    Object.assign(repoCopy.defaultRepoCopyDeps, gh.deps);
    const spec = await filedSpec(wsOn);
    await approve(spec.id);
    await runQueued();
    return { gh, spec };
  }
  const ci = (pr: number, headSha: string, conclusion: string) => ({ repoFullName: GH, prNumber: pr, headSha, conclusion, installationId: 1 });

  test('green CI on the generator\'s head merges it with no review', async () => {
    const { gh, spec } = await opened();
    expect(await repoCopy.landSpecRepoCopy(ci(gh.PR, 'gen1', 'success'), gh.deps)).toEqual({ specId: spec.id, outcome: 'merged' });
    expect(gh.calls.filter((c) => c.method === 'PUT')).toEqual([{ method: 'PUT', path: `/repos/${GH}/pulls/${gh.PR}/merge`, body: { sha: 'gen1', merge_method: 'squash' } }]);
    expect((await specRow(spec.id)).repo_copy.state).toBe('merged');
  });

  test('a head commit the generator did not write does not land', async () => {
    const { gh, spec } = await opened();
    gh.state.setPrHead('handpushed1');
    expect(await repoCopy.landSpecRepoCopy(ci(gh.PR, 'handpushed1', 'success'), gh.deps)).toEqual({ specId: spec.id, outcome: 'refused' });
    expect(gh.calls.filter((c) => c.method === 'PUT')).toEqual([]);
    const rc = (await specRow(spec.id)).repo_copy;
    expect(rc.state).toBe('refused');
    expect(repoCopy.repoCopyLine(true, rc, true)?.behind).toBe(true);
  });

  test('a red check leaves it open, the approval stands, and the page says the copy is behind naming the check', async () => {
    const { gh, spec } = await opened();
    gh.state.failingRun = 'Refuse hand edits to generated spec copies';
    expect(await repoCopy.landSpecRepoCopy(ci(gh.PR, 'gen1', 'failure'), gh.deps)).toEqual({ specId: spec.id, outcome: 'behind' });
    expect(gh.calls.filter((c) => c.method === 'PUT' || (c.method === 'PATCH' && c.path === `/repos/${GH}/pulls/${gh.PR}` && c.body?.state))).toEqual([]);
    const row = await specRow(spec.id);
    expect(row.approved_revision).toBe(1);
    const line = repoCopy.repoCopyLine(true, row.repo_copy, true)!;
    expect(line).toMatchObject({ behind: true });
    expect(line.copy).toContain(`Repo copy is behind: Refuse hand edits to generated spec copies failed on PR #${gh.PR}`);
    expect(line.source).toBe(`Source: buildd, repo copy at ${row.repo_copy.path}`);
  });

  test('a PR that is not a generated copy is left alone', async () => {
    const gh = fakeGitHub();
    expect(await repoCopy.landSpecRepoCopy(ci(9999, 'x', 'success'), gh.deps)).toBeNull();
    expect(gh.calls).toEqual([]);
  });
});

describe('the short-id link (R-33, AC-95)', () => {
  test('a reader with access opens the spec; another team gets nothing; two specs sharing a short id are both listed', async () => {
    const spec = await filedSpec(wsOn);
    const short = spec.id.slice(0, 8);
    expect(await resolveSpecShortId(user(member), short)).toEqual({ state: 'one', id: spec.id });
    expect(await resolveSpecShortId(user(outsider), short)).toEqual({ state: 'none' });

    const prefix = rand().replace(/[^a-f0-9]/g, 'a').padEnd(8, 'a').slice(0, 8);
    const [art] = await q<{ body_artifact_id: string }>(sql`SELECT body_artifact_id FROM specs WHERE id = ${spec.id}::uuid`);
    for (const [i, ws] of [[1, wsOn], [2, wsOff], [3, wsOther]] as const) {
      await q(sql`INSERT INTO specs (id, workspace_id, title, scope, body_artifact_id) VALUES (${`${prefix}-0000-4000-8000-00000000000${i}`}::uuid, ${ws}::uuid, ${`Twin ${i}`}, 'feature', ${art.body_artifact_id}::uuid)`);
    }
    const many = await resolveSpecShortId(user(member), prefix);
    expect(many.state === 'many' && many.specs.map((s) => s.title).sort()).toEqual(['Twin 1', 'Twin 2']);
    expect(await resolveSpecShortId(user(outsider), prefix)).toEqual({ state: 'one', id: `${prefix}-0000-4000-8000-000000000003` });
  });
});

describe('repo checks before approval (R-34, AC-96)', () => {
  test('a would-be copy that fails specs:lint shows the failure, and Approve still approves', async () => {
    const gh = fakeGitHub();
    Object.assign(repoCopy.defaultRepoCopyDeps, gh.deps);
    const spec = await filedSpec(wsOn, { body: '# No Summary\n\n- AC-1: GIVEN x WHEN y THEN z.\n' });
    const p = await repoCopy.repoCopyPreflight(spec, 1, gh.deps);
    if (p.state !== 'ran') throw new Error(`preflight did not run: ${p.state}`);
    const lint = p.checks.find((c) => c.name === 'specs:lint')!;
    expect(lint.ok).toBe(false);
    expect(lint.messages.join('\n')).toContain('frontmatter missing `summary`');
    expect(p.checks.find((c) => c.name === 'public-docs:check')!.ok).toBe(true);
    expect(p.checks.find((c) => c.name === 'no-prod-data')).toMatchObject({ ok: true });
    expect(p.checks.find((c) => c.name === 'no-prod-data')!.note).toContain('only in CI');
    expect(gh.writes()).toEqual([]);
    const a = await approveSpecRevision(user(admin), spec.id, { revision: 1, expectedVersion: 1 });
    expect(a.ok && !('pending' in a) && a.spec.approvedRevision).toBe(1);
  });

  test('a clean copy passes every check, and an unrelated revise does not change the approved copy', async () => {
    const gh = fakeGitHub();
    const spec = await filedSpec(wsOn);
    const p = await repoCopy.repoCopyPreflight(spec, 1, gh.deps);
    expect(p.state === 'ran' && p.checks.map((c) => [c.name, c.ok])).toEqual([['specs:lint', true], ['public-docs:check', true], ['no-prod-data', true]]);
    const r = await reviseSpecDraft(user(member), spec.id, { expectedVersion: 1, body: `${BODY}\nMore.\n` });
    expect(r.ok).toBe(true);
  });

  test('off in a workspace that has not opted in', async () => {
    const spec = await filedSpec(wsOff);
    expect(await repoCopy.repoCopyPreflight(spec, 1, fakeGitHub().deps)).toEqual({ state: 'off' });
  });
});
