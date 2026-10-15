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
function fakeGitHub(opts: { specFiles?: Record<string, string>; private?: boolean; decide?: any } = {}) {
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
    // Private by default: the repo-copy tests below publish under the private-repo rule (Slice 14).
    if (method === 'GET' && path === `/repos/${GH}`) return { default_branch: 'dev', private: opts.private ?? true };
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
    if (method === 'POST' && path === `/repos/${GH}/pulls` && String(body?.head ?? '').startsWith('buildd/spec-copy-removal-')) return { number: PR + 5000 };
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
    specFiles,
    deps: { api, repo: async () => ({ fullName: GH, installationId: 1 }), now: () => new Date('2026-10-13T12:00:00Z'), decide: opts.decide },
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
  // Slice 14: wsOn has an approved publication policy (D-21), on its product spec.
  await productPolicy(wsOn);
});

const POLICY = `# Shop

## Publication

May be published:

- How a feature behaves for the people who use it.

Stays in buildd:

- Operator-only tooling and how the platform is run day to day.
`;

/** An approved product spec carrying a Publication section; its approval's after-work is dropped. */
async function productPolicy(ws: string, body = POLICY) {
  const r = await createSpecDraft(user(member), { workspaceId: ws, title: `Shop ${rand()}`, scope: 'product', body }, { duplicates: false });
  if (!r.ok) throw new Error(r.error);
  await approve(r.spec.id);
  queued.length = 0;
  return r.spec;
}

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
    // A summary written as a list: the copy always carries a summary now, so a malformed one is the failure.
    const spec = await filedSpec(wsOn, { body: '---\nsummary: [one, two]\n---\n# List Summary\n\n- AC-1: GIVEN x WHEN y THEN z.\n' });
    const p = await repoCopy.repoCopyPreflight(spec, 1, gh.deps);
    if (p.state !== 'ran') throw new Error(`preflight did not run: ${p.state}`);
    const lint = p.checks.find((c) => c.name === 'specs:lint')!;
    expect(lint.ok).toBe(false);
    expect(lint.messages.join('\n')).toContain('`summary` must be a single sentence, not a list');
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


// ── Slice 14: which specs leave buildd ──────────────────────────────────────

const { decidePublication, specPublicationKind } = await import('../../src/lib/spec-publication-decision');
const { runDecisionKind } = await import('@builddai/ai-kit/decide');

/** A decision model that always gives this answer, through the real kind (rules first, then the model). */
function modelSays(answer: string, p: number, line = 'line_1', bar?: number) {
  const asked: unknown[] = [];
  const route = {
    provider: 'test', model: 'typesafe/jev-1.13',
    invoke: async (req: { state: unknown }) => {
      asked.push(req.state);
      return {
        ok: true, model: 'typesafe/jev-1.13', usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, latencyMs: 1, attempts: 1,
        answers: {
          publication: { type: 'choice', choice: answer, confidence: p, probabilities: { [answer]: p } },
          line: { type: 'choice', choice: line, confidence: 1, probabilities: { [line]: 1 } },
        },
      };
    },
  };
  const decide = (input: any) => decidePublication(input, {
    teamOf: async () => teamA,
    ...(bar === undefined ? {} : { bar }),
    judge: async (request) => ({ response: await runDecisionKind(specPublicationKind, request as any, { mode: 'live', cheap: route as any }) as any, recordId: null }),
  });
  return { decide, asked };
}

describe('publication (Slice 14, AC-49 to AC-53)', () => {
  test('AC-49: with no approved policy, approving writes nothing to GitHub and the page says there is no policy yet', async () => {
    const { workspaceId: ws } = await seedWorkspace();
    await q(sql`UPDATE workspaces SET team_id = ${teamA}::uuid, access_mode = 'open', git_config = coalesce(git_config, '{}'::jsonb) || ${JSON.stringify({ livingSpecs: { nativeSource: true } })}::jsonb WHERE id = ${ws}::uuid`);
    const { decide, asked } = modelSays('publish', 1);
    const gh = fakeGitHub({ private: false, decide });
    Object.assign(repoCopy.defaultRepoCopyDeps, gh.deps);
    const spec = await filedSpec(ws);
    await approve(spec.id);
    await runQueued();
    expect(gh.writes()).toEqual([]);
    expect(asked).toEqual([]);
    const rc = (await specRow(spec.id)).repo_copy;
    expect(rc).toMatchObject({ state: 'private', publication: { publish: false, source: 'rule', reasonCode: 'rule_no_policy', revision: 1 } });
    expect(repoCopy.repoCopyLine(true, rc, true)!.copy).toContain('no publication policy yet');
  });

  test('AC-52 and AC-51: a public repo and a model answer below the bar: the scan and decision run first, no write, recorded as a fallback', async () => {
    const { decide, asked } = modelSays('publish', 0.97, 'line_1');
    const gh = fakeGitHub({ private: false, decide });
    Object.assign(repoCopy.defaultRepoCopyDeps, gh.deps);
    const spec = await filedSpec(wsOn);
    await approve(spec.id);
    await runQueued();
    expect(asked).toHaveLength(1);
    expect(String(asked[0])).toContain('Operator-only tooling');
    expect(gh.writes()).toEqual([]);
    expect(gh.calls.every((c) => c.method === 'GET')).toBe(true);
    const rc = (await specRow(spec.id)).repo_copy;
    expect(rc).toMatchObject({ state: 'private', publication: { publish: false, source: 'fallback', reasonCode: 'below_bar', confidence: 0.97, line: 'How a feature behaves for the people who use it.' } });
    expect(rc.publication.policyVersion).toMatch(/^[0-9a-f]{8}-r1$/);
    const line = repoCopy.repoCopyLine(true, rc, true)!;
    expect(line.copy).toContain('Not published:');
    expect(line.publishAnyway).toBe(true);
  });

  test('AC-51: with no decision model for the team, a spec the rules leave open stays private as a fallback', async () => {
    const gh = fakeGitHub({ private: false });
    Object.assign(repoCopy.defaultRepoCopyDeps, gh.deps);
    const spec = await filedSpec(wsOn);
    await approve(spec.id);
    await runQueued();
    expect(gh.writes()).toEqual([]);
    const rc = (await specRow(spec.id)).repo_copy;
    expect(rc).toMatchObject({ state: 'private', publication: { publish: false, source: 'fallback' } });
    // R-69: the decision is on the ledger with the policy version in its replay; "Publish anyway" labels it (R-68).
    const recordId = rc.publication.decisionRecordId;
    expect(recordId).toBeTruthy();
    const r = await repoCopy.publishSpecAnyway(user(admin), spec.id, gh.deps);
    expect(r.ok).toBe(true);
    const [row] = await q<{ capability: string; human_override: any; overridden_by: string }>(sql`SELECT capability, human_override, overridden_by FROM decision_records WHERE id = ${recordId}::uuid`);
    expect(row).toMatchObject({ capability: 'buildd.spec_publication', human_override: { decision: 'publish', reason: 'published_anyway', revision: 1 }, overridden_by: admin });
  });

  test('AC-50: a spec a person marked private is never written, whatever the model answers, in a private repo too; an area mark is inherited', async () => {
    const { decide, asked } = modelSays('publish', 1, 'line_1', 0.5);
    const gh = fakeGitHub({ private: true, decide });
    Object.assign(repoCopy.defaultRepoCopyDeps, gh.deps);
    const spec = await filedSpec(wsOn);
    const m = await updateSpecMetadata(user(member), spec.id, { changes: { publication: 'private' }, reason: 'operator-only tooling' });
    expect(m.ok).toBe(true);
    await approve(spec.id);
    await runQueued();
    expect(gh.writes()).toEqual([]);
    expect(asked).toEqual([]);
    const rc = (await specRow(spec.id)).repo_copy;
    expect(rc.publication).toMatchObject({ reasonCode: 'rule_marked_private' });
    expect(repoCopy.repoCopyLine(true, rc, true)).toMatchObject({ copy: 'Not published: a person marked this spec private.', publishAnyway: false });

    const member2 = await filedSpec(wsOn);
    const [{ parent_spec_id: areaId }] = await q<{ parent_spec_id: string }>(sql`SELECT parent_spec_id FROM specs WHERE id = ${member2.id}::uuid`);
    expect((await updateSpecMetadata(user(member), areaId, { changes: { publication: 'private' }, reason: 'the whole area is operator tooling' })).ok).toBe(true);
    await approve(member2.id);
    await runQueued();
    expect((await specRow(member2.id)).repo_copy.publication.reason).toBe('Not published: its area is marked private.');
    expect(gh.writes()).toEqual([]);
  });

  test('AC-50: a spec marked public whose text has a production-data hit is not written, and the page names the hit', async () => {
    const gh = fakeGitHub({ private: false });
    Object.assign(repoCopy.defaultRepoCopyDeps, gh.deps);
    const spec = await filedSpec(wsOn, { body: `${BODY}\nFirst seen on spec 1a2b3c4d-0000-4000-8000-00000000abcd.\n` });
    expect((await updateSpecMetadata(user(member), spec.id, { changes: { publication: 'public' }, reason: 'reviewed for the repo' })).ok).toBe(true);
    await approve(spec.id);
    await runQueued();
    expect(gh.writes()).toEqual([]);
    const rc = (await specRow(spec.id)).repo_copy;
    expect(rc.publication).toMatchObject({ reasonCode: 'rule_prod_data' });
    expect(repoCopy.repoCopyLine(true, rc, true)!.copy).toMatch(/production data \(line \d+: a UUID/);
  });

  test('R-66: an agent may mark a spec private but not public', async () => {
    const spec = await filedSpec(wsOn);
    expect(await updateSpecMetadata(agentToken(wsOn), spec.id, { changes: { publication: 'public' }, reason: 'publish it' })).toMatchObject({ ok: false, status: 403 });
    expect((await updateSpecMetadata(agentToken(wsOn), spec.id, { changes: { publication: 'private' }, reason: 'keep it in' })).ok).toBe(true);
    expect((await specRow(spec.id)).metadata.publication).toBe('private');
    expect(await updateSpecMetadata(agentToken(wsOn), spec.id, { changes: { publication: 'policy' }, reason: 'lift it' })).toMatchObject({ ok: false, status: 403 });
    expect((await updateSpecMetadata(user(member), spec.id, { changes: { publication: 'policy' }, reason: 'follow the policy again' })).ok).toBe(true);
    expect((await specRow(spec.id)).metadata.publication).toBeUndefined();
  });

  test('R-68: a person who may approve publishes a kept-private spec anyway; a member cannot', async () => {
    const { decide } = modelSays('unsure', 0.6);
    const gh = fakeGitHub({ private: false, decide });
    Object.assign(repoCopy.defaultRepoCopyDeps, gh.deps);
    const spec = await filedSpec(wsOn);
    await approve(spec.id);
    await runQueued();
    expect(gh.writes()).toEqual([]);
    expect(await repoCopy.publishSpecAnyway(user(member), spec.id, gh.deps)).toMatchObject({ ok: false, status: 403 });
    const r = await repoCopy.publishSpecAnyway(user(admin), spec.id, gh.deps);
    expect(r.ok && r.repoCopy).toMatchObject({ state: 'open', publication: { publish: true, source: 'person' }, publishAnyway: { by: `user:${admin}`, revision: 1 } });
    expect(gh.calls.filter((c) => c.method === 'POST' && c.path === `/repos/${GH}/pulls`)).toHaveLength(1);
  });

  test('AC-53: a policy revision that makes a published spec private lists it with a removal PR and changes nothing until a person merges it', async () => {
    const { workspaceId: ws } = await seedWorkspace();
    await q(sql`UPDATE workspaces SET team_id = ${teamA}::uuid, access_mode = 'open', git_config = coalesce(git_config, '{}'::jsonb) || ${JSON.stringify({ livingSpecs: { nativeSource: true } })}::jsonb WHERE id = ${ws}::uuid`);
    const product = await productPolicy(ws);
    // Published under a public mark, then landed.
    const gh = fakeGitHub({ private: false, decide: modelSays('keep_private', 0.99, 'line_2').decide });
    Object.assign(repoCopy.defaultRepoCopyDeps, gh.deps);
    const spec = await filedSpec(ws);
    expect((await updateSpecMetadata(user(member), spec.id, { changes: { publication: 'public' }, reason: 'reviewed for the repo' })).ok).toBe(true);
    await approve(spec.id);
    await runQueued();
    const opened = (await specRow(spec.id)).repo_copy;
    expect(opened.state).toBe('open');
    expect(await repoCopy.landSpecRepoCopy({ repoFullName: GH, prNumber: gh.PR, headSha: opened.headSha, conclusion: 'success', installationId: 1 }, gh.deps)).toMatchObject({ outcome: 'merged' });
    const file = opened.path.slice('docs/specs/'.length);
    gh.specFiles[file] = gh.lastTree().find((f) => f.path === opened.path)!.content;

    // The mark is lifted (its after-work dropped), then a new policy revision is approved.
    queued.length = 0;
    expect((await updateSpecMetadata(user(member), spec.id, { changes: { publication: 'policy' }, reason: 'follow the policy' })).ok).toBe(true);
    queued.length = 0;
    const r2 = await reviseSpecDraft(user(member), product.id, { expectedVersion: (await specRow(product.id)).version, body: `${POLICY}- Widget exports, until they ship.\n` });
    if (!r2.ok) throw new Error(r2.error);
    const before = gh.calls.length;
    await approve(product.id, 2, (await specRow(product.id)).version);
    await runQueued();

    const writes = gh.calls.slice(before).filter((c) => c.method !== 'GET' && c.path !== '/graphql');
    const removalTree = writes.find((c) => c.path === `/repos/${GH}/git/trees`)!.body.tree;
    expect(removalTree).toContainEqual({ path: opened.path, mode: '100644', type: 'blob', sha: null });
    const prs = writes.filter((c) => c.method === 'POST' && c.path === `/repos/${GH}/pulls`);
    expect(prs).toHaveLength(1);
    expect(prs[0].body.head).toMatch(/^buildd\/spec-copy-removal-/);
    expect(prs[0].body.body).toContain('does not erase it from the repo\'s history');
    // Nothing merged, no base branch moved: the removal waits for a person.
    expect(writes.filter((c) => c.method === 'PUT' || c.method === 'PATCH')).toEqual([]);

    const rc = (await specRow(spec.id)).repo_copy;
    expect(rc).toMatchObject({ state: 'private', removal: { path: opened.path, prNumber: gh.PR + 5000 }, publication: { policyVersion: expect.stringMatching(/-r2$/) } });
    expect(repoCopy.repoCopyLine(true, rc, true)!.copy).toContain(`PR #${gh.PR + 5000} removes it once a person merges it`);
    // The old copy PR's head cannot land under the exception any more.
    expect(await repoCopy.landSpecRepoCopy({ repoFullName: GH, prNumber: gh.PR, headSha: opened.headSha, conclusion: 'success', installationId: 1 }, gh.deps)).toEqual({ specId: spec.id, outcome: 'kept_private' });
  });
});
