/**
 * Importing repo spec files into buildd (docs/specs/living-specs.md §18, R-18,
 * R-19, AC-76, AC-77), against real Postgres with a fake GitHub: the dry run,
 * the import (filed under its area, provenance, metadata block, imported not
 * approved), idempotence and re-import, the duplicate report, and the one
 * person-only bulk confirmation with its stale check.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

process.env.AUTH_SECRET ||= 'spec-import-test-secret';

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision, specApprovalDeps } = await import('../../src/lib/specs/approval');
const { updateSpecMetadata } = await import('../../src/lib/specs/metadata');
const { organizeDeps } = await import('../../src/lib/specs/organize');
const repoCopy = await import('../../src/lib/specs/repo-copy');
const { importRepoSpecs, confirmImportedSpecs } = await import('../../src/lib/specs/import');
const { db } = await import('@buildd/core/db');
const { specs } = await import('@buildd/core/db/schema');

const rand = () => Math.random().toString(36).slice(2, 10);
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');

async function person(teamId: string, role: 'owner' | 'admin' | 'member') {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, ${role})`);
  return u.id;
}
const user = (userId: string) => ({ kind: 'user' as const, userId });

const spec = (title: string, domain: string, extra = '') => `---
title: ${title}
status: draft
owner: someone
last_verified: 2026-10-01
summary: ${title} MUST hold.
domain: ${domain}
verified_by: [apps/web/src/lib/${title.toLowerCase().replace(/\W+/g, '-')}.test.ts]
${extra}---
# ${title}

- R-1: ${title} holds for every widget.
`;

/** A fake GitHub: one repo whose docs/specs the test edits, and every call it saw. */
function fakeGitHub(files: Record<string, string>) {
  const GH = `acme/app-${rand()}`;
  const state = { commit: hex(40), files: new Map(Object.entries(files).map(([n, t]) => [n, { text: t, oid: hex(40) }])), prOf: new Map<string, number>() };
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const api = async (_inst: number, path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    if (method === 'GET' && path === `/repos/${GH}`) return { default_branch: 'dev' };
    if (method === 'GET' && path === `/repos/${GH}/commits/dev`) return { sha: state.commit };
    if (method === 'POST' && path === '/graphql') {
      const query: string = body.query;
      if (query.includes('history(')) {
        const commit: Record<string, unknown> = {};
        for (const m of query.matchAll(/(f\d+): history\(first: 1, path: ("[^"]+")\)/g)) {
          const p = JSON.parse(m[2]!) as string;
          const pr = state.prOf.get(p.slice('docs/specs/'.length));
          commit[m[1]!] = { nodes: [{ oid: hex(40), associatedPullRequests: { nodes: pr ? [{ number: pr, merged: true }] : [] } }] };
        }
        return { data: { repository: { commit } } };
      }
      return { data: { repository: { specs: { entries: [...state.files].map(([name, f]) => ({ name, type: 'blob', oid: f.oid, object: { text: f.text } })) } } } };
    }
    throw new Error(`fake GitHub: unexpected ${method} ${path}`);
  };
  return {
    GH, state, calls,
    deps: { api, repo: async () => ({ fullName: GH, installationId: 1 }), now: () => new Date('2026-10-13T12:00:00Z'), duplicates: false as const },
    edit(name: string, text: string) { state.files.set(name, { text, oid: hex(40) }); state.commit = hex(40); },
    writes: () => calls.filter((c) => c.method !== 'GET' && c.path !== '/graphql'),
  };
}

let teamA: string; let ws: string; let wsNative: string;
let admin: string; let member: string;
const queued: Array<() => Promise<unknown>> = [];
const ACCOUNT = '00000000-0000-4000-8000-0000000000b3';
const agentToken = (w: string) => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId: teamA, workspaceIds: null, taskScope: { taskId: '00000000-0000-4000-8000-0000000000f3', workspaceId: w } } as any });
const apiKey = () => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId: teamA, workspaceIds: null } as any });
const oauth = (userId: string) => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId: teamA, workspaceIds: null, sessionUserId: userId } as any });

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: ws } = await seedWorkspace());
  ({ workspaceId: wsNative } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET team_id = ${teamA}::uuid, access_mode = 'open' WHERE id IN (${ws}::uuid, ${wsNative}::uuid)`);
  await q(sql`UPDATE workspaces SET git_config = coalesce(git_config, '{}'::jsonb) || ${JSON.stringify({ livingSpecs: { nativeSource: true } })}::jsonb WHERE id = ${wsNative}::uuid`);
  admin = await person(teamA, 'admin');
  member = await person(teamA, 'member');
  specApprovalDeps.afterResponse = (task) => { queued.push(task); };
  organizeDeps.classify = async () => ({ ran: false, reason: 'no decision model in this test' });
  organizeDeps.suggest = async () => null;
});
afterEach(() => { queued.length = 0; });

async function area(w: string, title: string) {
  const r = await createSpecDraft(user(member), { workspaceId: w, title, scope: 'domain', body: `# ${title}\n${title} and their rules.\n` }, { duplicates: false });
  if (!r.ok) throw new Error(r.error);
  return r.spec.id;
}
const specCount = async (w: string) => Number((await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM specs WHERE workspace_id = ${w}::uuid`))[0]!.n);
const importedRows = (w: string) => q<{ id: string; repo_source: any; approved_revision: number | null; head_revision: number; parent_spec_id: string | null; metadata: any }>(sql`
  SELECT id, repo_source, approved_revision, head_revision, parent_spec_id, metadata FROM specs WHERE workspace_id = ${w}::uuid AND repo_source IS NOT NULL ORDER BY repo_source->>'path'`);

describe('import: the dry run (R-18)', () => {
  test('creates nothing and says, per file, the spec, its area, its provenance and why a file is skipped', async () => {
    const w = (await seedWorkspace()).workspaceId;
    await q(sql`UPDATE workspaces SET team_id = ${teamA}::uuid, access_mode = 'open' WHERE id = ${w}::uuid`);
    const billing = await area(w, 'Billing');
    const gh = fakeGitHub({
      'invoices.md': spec('Invoices', 'billing'),
      'refunds.md': spec('Refunds', 'payments-ops'),
      'panels.md': spec('Panels', 'surfaces'),
      'old.md': spec('Old Thing', 'billing').replace('status: draft', 'status: superseded\nsuperseded_by: invoices'),
      'SPEC-FORMAT.md': '# Spec format\n',
      'INDEX.md': '<!-- GENERATED -->\n# Spec Index\n',
    });
    gh.state.prOf.set('invoices.md', 4242);
    const before = await specCount(w);
    const r = await importRepoSpecs(user(member), { workspaceId: w }, gh.deps);
    if (!r.ok) throw new Error(r.error);
    expect(r.result.dryRun).toBe(true);
    expect(await specCount(w)).toBe(before);
    const by = new Map(r.result.files.map((f) => [f.path, f]));
    const inv = by.get('docs/specs/invoices.md')!;
    expect(inv.action).toBe('create');
    expect(inv.spec).toMatchObject({ title: 'Invoices', scope: 'feature' });
    expect(inv.spec!.body).not.toContain('verified_by');
    expect(inv.spec!.body).toContain('summary: Invoices MUST hold.');
    expect(inv.metadata.verified_by).toEqual(['apps/web/src/lib/invoices.test.ts']);
    expect(inv.area).toMatchObject({ specId: billing, title: 'Billing', proposed: false });
    expect(inv.provenance).toMatchObject({ path: 'docs/specs/invoices.md', commitSha: gh.state.commit, prNumber: 4242 });
    expect(by.get('docs/specs/refunds.md')!.area).toMatchObject({ specId: null, title: 'Payments Ops', proposed: true });
    // A cross-cutting domain names a kind of code, not an area: organize places it instead.
    expect(by.get('docs/specs/panels.md')).toMatchObject({ action: 'create', area: null });
    expect(by.get('docs/specs/old.md')).toMatchObject({ action: 'skip', reason: 'superseded' });
    expect(by.get('docs/specs/SPEC-FORMAT.md')).toMatchObject({ action: 'skip', reason: 'meta_file' });
    expect(by.get('docs/specs/INDEX.md')).toMatchObject({ action: 'skip', reason: 'meta_file' });
    expect(gh.writes()).toEqual([]);
  });
});

describe('import: writing it (R-18, AC-76)', () => {
  test('imports revision 1 marked imported, not approved, filed under the area its domain names, metadata in the block', async () => {
    const billing = await area(ws, `Billing ${rand()}`);
    const domain = repoCopy.areaDomain((await q<{ title: string }>(sql`SELECT title FROM specs WHERE id = ${billing}::uuid`))[0]!.title);
    const gh = fakeGitHub({ 'invoices.md': spec('Invoices', domain) });
    gh.state.prOf.set('invoices.md', 77);
    const r = await importRepoSpecs(user(member), { workspaceId: ws, dryRun: false }, gh.deps);
    if (!r.ok) throw new Error(r.error);
    const row = r.result.files.find((f) => f.path === 'docs/specs/invoices.md')!;
    expect(row.action).toBe('create');
    const [s] = await q<any>(sql`SELECT * FROM specs WHERE id = ${row.specId!}::uuid`);
    expect(s.approved_revision).toBeNull();
    expect(s.parent_spec_id).toBe(billing);
    expect(s.repo_source).toMatchObject({ state: 'imported', path: 'docs/specs/invoices.md', commitSha: gh.state.commit, prNumber: 77, revision: 1 });
    expect(s.metadata).toMatchObject({ owner: 'someone', last_verified: '2026-10-01', verified_by: ['apps/web/src/lib/invoices.test.ts'] });
    const [rev] = await q<any>(sql`SELECT * FROM spec_revisions WHERE spec_id = ${row.specId!}::uuid AND revision = 1`);
    expect(rev.approved_at).toBeNull();
    expect(rev.imported).toMatchObject({ path: 'docs/specs/invoices.md', commitSha: gh.state.commit });
    const [filing] = await q<any>(sql`SELECT * FROM spec_filings WHERE spec_id = ${row.specId!}::uuid`);
    expect(filing).toMatchObject({ kind: 'filed', status: 'applied', parent_spec_id: billing, source: 'domain' });
  });

  test('is idempotent: a second run with no repo change imports nothing; a changed file becomes a new imported revision', async () => {
    const w = (await seedWorkspace()).workspaceId;
    await q(sql`UPDATE workspaces SET team_id = ${teamA}::uuid, access_mode = 'open' WHERE id = ${w}::uuid`);
    const gh = fakeGitHub({ 'a.md': spec('Alpha', 'ops'), 'b.md': spec('Beta', 'ops') });
    const first = await importRepoSpecs(user(member), { workspaceId: w, dryRun: false }, gh.deps);
    if (!first.ok) throw new Error(first.error);
    expect(first.result.files.filter((f) => f.action === 'create')).toHaveLength(2);
    const count = await specCount(w);

    const again = await importRepoSpecs(user(member), { workspaceId: w, dryRun: false }, gh.deps);
    if (!again.ok) throw new Error(again.error);
    expect(again.result.files.every((f) => f.action === 'skip' && f.reason === 'already_imported')).toBe(true);
    expect(await specCount(w)).toBe(count);

    gh.edit('a.md', spec('Alpha', 'ops').replace('holds for every widget', 'holds for every widget and gadget'));
    const dry = await importRepoSpecs(user(member), { workspaceId: w }, gh.deps);
    if (!dry.ok) throw new Error(dry.error);
    expect(dry.result.files.find((f) => f.path === 'docs/specs/a.md')!.action).toBe('reimport');
    const re = await importRepoSpecs(user(member), { workspaceId: w, dryRun: false }, gh.deps);
    if (!re.ok) throw new Error(re.error);
    const a = re.result.files.find((f) => f.path === 'docs/specs/a.md')!;
    expect(a).toMatchObject({ action: 'reimport', revision: 2 });
    expect(await specCount(w)).toBe(count);
    const [s] = await q<any>(sql`SELECT * FROM specs WHERE id = ${a.specId!}::uuid`);
    expect(s).toMatchObject({ head_revision: 2, approved_revision: null });
    expect(s.repo_source).toMatchObject({ state: 'imported', revision: 2, commitSha: gh.state.commit });
    const [rev] = await q<any>(sql`SELECT * FROM spec_revisions WHERE spec_id = ${a.specId!}::uuid AND revision = 2`);
    expect(rev.imported).toMatchObject({ commitSha: gh.state.commit });
    expect(rev.approved_at).toBeNull();
  });

  test('a duplicate of an approved native spec is reported in the dry run and skipped on import, not created silently', async () => {
    const w = (await seedWorkspace()).workspaceId;
    await q(sql`UPDATE workspaces SET team_id = ${teamA}::uuid, access_mode = 'open' WHERE id = ${w}::uuid`);
    const native = await createSpecDraft(user(member), { workspaceId: w, title: 'Invoices', body: '# Invoices\n\n- R-1: Invoices holds for every widget.\n' }, { duplicates: false });
    if (!native.ok) throw new Error(native.error);
    const ok = await approveSpecRevision(user(admin), native.spec.id, { revision: 1, expectedVersion: 1 });
    if (!ok.ok) throw new Error(ok.error);
    const gh = fakeGitHub({ 'invoices.md': spec('Invoices', 'billing'), 'other.md': spec('Shipping Labels', 'billing') });
    const deps = {
      ...gh.deps,
      duplicates: { judge: async (pair: any) => ({ response: { decision: pair.b.title === 'Invoices' ? 'duplicate' : 'distinct', confidence: 0.96, source: 'model', fallbackCause: null } as any, recordId: null }) },
    };
    const dry = await importRepoSpecs(user(member), { workspaceId: w }, deps);
    if (!dry.ok) throw new Error(dry.error);
    const inv = dry.result.files.find((f) => f.path === 'docs/specs/invoices.md')!;
    expect(inv.duplicates.map((d) => d.specId)).toEqual([native.spec.id]);
    expect(inv.action).toBe('create');
    const real = await importRepoSpecs(user(member), { workspaceId: w, dryRun: false }, deps);
    if (!real.ok) throw new Error(real.error);
    expect(real.result.files.find((f) => f.path === 'docs/specs/invoices.md')).toMatchObject({ action: 'skip', reason: 'duplicate' });
    expect(real.result.files.find((f) => f.path === 'docs/specs/other.md')).toMatchObject({ action: 'create' });
    const forced = await importRepoSpecs(user(member), { workspaceId: w, dryRun: false, allowDuplicates: ['docs/specs/invoices.md'] }, deps);
    if (!forced.ok) throw new Error(forced.error);
    expect(forced.result.files.find((f) => f.path === 'docs/specs/invoices.md')).toMatchObject({ action: 'create' });
  });

  test('an imported spec is not revised in buildd and not approved outside confirmation: the repo file stays the source', async () => {
    const w = (await seedWorkspace()).workspaceId;
    await q(sql`UPDATE workspaces SET team_id = ${teamA}::uuid, access_mode = 'open' WHERE id = ${w}::uuid`);
    const gh = fakeGitHub({ 'c.md': spec('Gamma', 'ops') });
    const r = await importRepoSpecs(user(member), { workspaceId: w, dryRun: false }, gh.deps);
    if (!r.ok) throw new Error(r.error);
    const id = r.result.files[0]!.specId!;
    const rev = await reviseSpecDraft(user(member), id, { expectedVersion: 1, body: '# Gamma\n\nedited in buildd\n' });
    expect(rev).toMatchObject({ ok: false, status: 409, code: 'spec_imported' });
    const app = await approveSpecRevision(user(admin), id, { revision: 1, expectedVersion: 1 });
    expect(app).toMatchObject({ ok: false, status: 409, code: 'spec_imported' });
  });
});

describe('AC-76: no repo copy before confirmation', () => {
  test('in a native-sourced workspace, an imported spec gets no PR, even on a metadata change; confirming writes its file', async () => {
    const billing = await area(wsNative, 'Billing');
    const gh = fakeGitHub({ 'invoices.md': spec('Invoices', 'billing') });
    const r = await importRepoSpecs(user(member), { workspaceId: wsNative, dryRun: false }, gh.deps);
    if (!r.ok) throw new Error(r.error);
    const id = r.result.files[0]!.specId!;
    expect((await q<any>(sql`SELECT parent_spec_id FROM specs WHERE id = ${id}::uuid`))[0]!.parent_spec_id).toBe(billing);
    const m = await updateSpecMetadata(user(member), id, { changes: { surfaces: ['apps/web/src/lib/invoices.ts'] }, reason: 'name the surface' });
    expect(m.ok).toBe(true);
    for (const t of queued.splice(0)) await t();
    const copyCalls: string[] = [];
    const copyDeps = { api: async (_i: number, path: string, init?: RequestInit) => { copyCalls.push(`${init?.method ?? 'GET'} ${path}`); throw new Error('no GitHub call expected'); }, repo: async () => ({ fullName: gh.GH, installationId: 1 }), now: () => new Date() };
    expect(await repoCopy.fileSpecRepoCopy(id, copyDeps)).toBeNull();
    expect(copyCalls).toEqual([]);
    expect((await q<any>(sql`SELECT repo_copy FROM specs WHERE id = ${id}::uuid`))[0]!.repo_copy).toBeNull();

    const c = await confirmImportedSpecs(user(admin), { workspaceId: wsNative, specIds: [id] }, gh.deps);
    if (!c.ok) throw new Error(c.error);
    expect(c.result.confirmed.map((x) => x.specId)).toEqual([id]);
    const [row] = await db.select().from(specs).where(eq(specs.id, id));
    const built = await repoCopy.buildSpecRepoCopy(row!);
    expect(built.ok && built.path).toBe('docs/specs/invoices.md');
  });
});

describe('AC-77: one person-only confirmation over a batch', () => {
  async function threeImported() {
    const w = (await seedWorkspace()).workspaceId;
    await q(sql`UPDATE workspaces SET team_id = ${teamA}::uuid, access_mode = 'open' WHERE id = ${w}::uuid`);
    const gh = fakeGitHub({ 'one.md': spec('One', 'ops'), 'two.md': spec('Two', 'ops'), 'three.md': spec('Three', 'ops') });
    const r = await importRepoSpecs(user(member), { workspaceId: w, dryRun: false }, gh.deps);
    if (!r.ok) throw new Error(r.error);
    const ids = Object.fromEntries(r.result.files.map((f) => [f.path, f.specId!]));
    return { w, gh, ids, all: Object.values(ids) };
  }

  test('a batch of three, one whose file moved since import: two are approved, the third is reported stale and stays imported', async () => {
    const { w, gh, ids, all } = await threeImported();
    gh.edit('three.md', spec('Three', 'ops').replace('every widget', 'every widget, changed'));
    const c = await confirmImportedSpecs(user(admin), { workspaceId: w, specIds: all }, gh.deps);
    if (!c.ok) throw new Error(c.error);
    expect(c.result.confirmed.map((x) => x.specId).sort()).toEqual([ids['docs/specs/one.md'], ids['docs/specs/two.md']].sort());
    expect(c.result.skipped).toEqual([expect.objectContaining({ specId: ids['docs/specs/three.md'], reason: 'stale' })]);
    const rows = new Map((await importedRows(w)).map((r) => [r.id, r]));
    const one = rows.get(ids['docs/specs/one.md']!)!;
    expect(one.approved_revision).toBe(1);
    expect(one.repo_source).toMatchObject({ state: 'confirmed', confirmedBy: `user:${admin}` });
    expect(one.repo_source.note).toMatch(/^confirmed import of docs\/specs\/one\.md@[0-9a-f]{7}$/);
    expect(typeof one.repo_source.confirmedAt).toBe('string');
    const [rev] = await q<any>(sql`SELECT approved_by FROM spec_revisions WHERE spec_id = ${one.id}::uuid AND revision = 1`);
    expect(rev.approved_by).toBe(`user:${admin}`);
    const three = rows.get(ids['docs/specs/three.md']!)!;
    expect(three.approved_revision).toBeNull();
    expect(three.repo_source.state).toBe('imported');
  });

  test('an agent token or an API key is refused with a 403 and nothing is approved; an OAuth session gets a link, not an approval', async () => {
    const { w, gh, all } = await threeImported();
    for (const caller of [agentToken(w), apiKey()]) {
      const r = await confirmImportedSpecs(caller, { workspaceId: w, specIds: all }, gh.deps);
      expect(r).toMatchObject({ ok: false, status: 403 });
    }
    const viaOauth = await confirmImportedSpecs(oauth(admin), { workspaceId: w, specIds: all }, gh.deps);
    if (!viaOauth.ok) throw new Error(viaOauth.error);
    expect(viaOauth.result.pending?.confirmUrl).toContain(`/app/workspaces/${w}/specs`);
    expect(viaOauth.result.confirmed).toEqual([]);
    const member403 = await confirmImportedSpecs(user(member), { workspaceId: w, specIds: all }, gh.deps);
    expect(member403).toMatchObject({ ok: false, status: 403 });
    expect((await importedRows(w)).every((r) => r.approved_revision === null && r.repo_source.state === 'imported')).toBe(true);
  });
});
