/**
 * Living Specs store (apps/web/src/lib/specs/store.ts), against real Postgres:
 * immutable revisions, version-checked drafts that two writers cannot silently
 * overwrite, and workspace scoping.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { createSpecDraft, reviseSpecDraft, relateSpec, getSpec, listSpecs } = await import('../../src/lib/specs/store');

const rand = () => Math.random().toString(36).slice(2, 10);
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
async function member(teamId: string) {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, 'member')`);
  return u.id;
}

let teamA: string; let wsA: string; let userA: string; let wsB: string; let userB: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${wsA}::uuid`);
  let teamB: string;
  ({ teamId: teamB, workspaceId: wsB } = await seedWorkspace());
  userA = await member(teamA);
  userB = await member(teamB);
});
const A = () => ({ kind: 'user' as const, userId: userA });
const agent = () => ({ kind: 'account' as const, account: { id: '00000000-0000-4000-8000-0000000000a1', teamId: teamA, workspaceIds: null } as any });

const BODY_1 = '# Checkout\nR-1: Totals are in the shopper\'s currency.\n- **AC-1** Given EUR, the total reads €.\n';

async function draft() {
  const r = await createSpecDraft(A(), { workspaceId: wsA, title: `Checkout ${rand()}`, body: BODY_1 });
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe('a spec has immutable revisions', () => {
  test('a draft is revision 1, pinned to its body by hash, with its requirement ids', async () => {
    const { spec, revision } = await draft();
    expect([spec.version, spec.headRevision, spec.status, revision.revision, revision.contentHash]).toEqual([1, 1, 'draft', 1, sha(BODY_1)]);
    const got = await getSpec(A(), spec.id);
    expect(got.ok && got.view.requirements.map((r) => r.id)).toEqual(['R-1', 'AC-1']);
  });

  test('revision N+1 leaves revision N readable byte for byte', async () => {
    const { spec } = await draft();
    const body2 = BODY_1 + 'R-2: Rates are cached for 15 minutes.\n';
    const r = await reviseSpecDraft(A(), spec.id, { expectedVersion: 1, body: body2, changeSummary: 'add caching' });
    expect(r.ok && [r.spec.version, r.revision.revision, r.revision.contentHash]).toEqual([2, 2, sha(body2)]);
    const v1 = await getSpec(A(), spec.id, { revision: 1 });
    const v2 = await getSpec(A(), spec.id);
    expect(v1.ok && v1.view.body).toBe(BODY_1);
    expect(v2.ok && v2.view.body).toBe(body2);
    expect(v2.ok && v2.view.revisions.map((x) => x.revision)).toEqual([2, 1]);
  });

  test('an unchanged body is not a new revision', async () => {
    const { spec } = await draft();
    const r = await reviseSpecDraft(A(), spec.id, { expectedVersion: 1, body: BODY_1 });
    expect(r.ok && [r.unchanged, r.spec.version]).toEqual([true, 1]);
  });
});

describe('two writers revising the same draft', () => {
  test('both from version 1: exactly one lands, the other is told the current version, and nothing is overwritten', async () => {
    const { spec } = await draft();
    const human = BODY_1 + 'R-2: human edit\n';
    const bot = BODY_1 + 'R-2: agent edit\n';
    const [a, b] = await Promise.all([
      reviseSpecDraft(A(), spec.id, { expectedVersion: 1, body: human }),
      reviseSpecDraft(agent(), spec.id, { expectedVersion: 1, body: bot }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const lost = (a.ok ? b : a) as { ok: false; status: number; currentVersion?: number };
    expect([lost.status, lost.currentVersion]).toEqual([409, 2]);
    const winner = a.ok ? human : bot;
    const head = await getSpec(A(), spec.id);
    expect(head.ok && head.view.body).toBe(winner);
    // The loser re-reads version 2 and revises on top: both edits are now in history.
    const merged = winner + (a.ok ? 'R-3: agent edit\n' : 'R-3: human edit\n');
    const retry = await reviseSpecDraft(a.ok ? agent() : A(), spec.id, { expectedVersion: 2, body: merged });
    expect(retry.ok && retry.revision.revision).toBe(3);
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM spec_revisions WHERE spec_id = ${spec.id}::uuid`);
    expect(n).toBe(3);
  });

  test('a stale version is refused with the current one', async () => {
    const { spec } = await draft();
    await reviseSpecDraft(A(), spec.id, { expectedVersion: 1, body: BODY_1 + 'x\n' });
    expect(await reviseSpecDraft(A(), spec.id, { expectedVersion: 1, body: BODY_1 + 'y\n' })).toMatchObject({ ok: false, status: 409, currentVersion: 2 });
  });

  test('an agent\'s revision is recorded as the agent\'s', async () => {
    const { spec } = await draft();
    const r = await reviseSpecDraft(agent(), spec.id, { expectedVersion: 1, body: BODY_1 + 'z\n' });
    expect(r.ok && [r.revision.authorKind, r.revision.approvedBy]).toEqual(['agent', null]);
  });
});

describe('workspace scoping', () => {
  test('another team neither reads, lists nor revises a spec, and cannot create one in the workspace', async () => {
    const { spec } = await draft();
    const B = { kind: 'user' as const, userId: userB };
    expect(await getSpec(B, spec.id)).toMatchObject({ ok: false, status: 404 });
    expect(await listSpecs(B, wsA)).toMatchObject({ ok: false, status: 404 });
    expect(await reviseSpecDraft(B, spec.id, { expectedVersion: 1, body: 'x' })).toMatchObject({ ok: false, status: 404 });
    expect(await createSpecDraft(B, { workspaceId: wsA, title: 't', body: 'b' })).toMatchObject({ ok: false, status: 404 });
  });

  test('a task token reaches only its own task\'s workspace', async () => {
    const { spec } = await draft();
    const token = { kind: 'account' as const, account: { id: '00000000-0000-4000-8000-0000000000a2', teamId: teamA, workspaceIds: null, taskScope: { workspaceId: wsB } } as any };
    expect(await getSpec(token, spec.id)).toMatchObject({ ok: false, status: 404 });
  });

  test('a parent spec must be in the same workspace', async () => {
    const { spec } = await draft();
    const child = await createSpecDraft(A(), { workspaceId: wsA, title: 'child', parentSpecId: spec.id, body: 'R-1: x' });
    expect(child.ok && child.spec.parentSpecId).toBe(spec.id);
    expect(await createSpecDraft(A(), { workspaceId: wsA, title: 'orphan', parentSpecId: '00000000-0000-4000-8000-000000000000', body: 'x' })).toMatchObject({ ok: false, status: 404 });
  });
});

describe('relating specs', () => {
  test('a parent is set, changed and cleared, and the body version does not move', async () => {
    const [{ spec: child }, { spec: p1 }, { spec: p2 }] = [await draft(), await draft(), await draft()];
    const set = await relateSpec(A(), child.id, { parentSpecId: p1.id });
    expect(set.ok && [set.spec.parentSpecId, set.spec.version]).toEqual([p1.id, 1]);
    const moved = await relateSpec(agent(), child.id, { parentSpecId: p2.id });
    expect(moved.ok && moved.spec.parentSpecId).toBe(p2.id);
    const cleared = await relateSpec(A(), child.id, { parentSpecId: null });
    expect(cleared.ok && cleared.spec.parentSpecId).toBe(null);
  });

  test('a relation that would close a cycle is refused and writes nothing', async () => {
    const [{ spec: a }, { spec: b }, { spec: c }] = [await draft(), await draft(), await draft()];
    expect((await relateSpec(A(), b.id, { parentSpecId: a.id })).ok).toBe(true);
    expect((await relateSpec(A(), c.id, { parentSpecId: b.id })).ok).toBe(true);
    // a -> c would make a its own grandchild's child.
    expect(await relateSpec(A(), a.id, { parentSpecId: c.id })).toMatchObject({ ok: false, status: 409 });
    expect(await relateSpec(A(), a.id, { parentSpecId: a.id })).toMatchObject({ ok: false, status: 409 });
    const [{ parent }] = await q<{ parent: string | null }>(sql`SELECT parent_spec_id AS parent FROM specs WHERE id = ${a.id}::uuid`);
    expect(parent).toBe(null);
  });

  test('a parent in another workspace, an unknown parent, or another team\'s caller is refused', async () => {
    const { spec } = await draft();
    const other = await createSpecDraft({ kind: 'user', userId: userB }, { workspaceId: wsB, title: 'elsewhere', body: 'R-1: x' });
    if (!other.ok) throw new Error(other.error);
    expect(await relateSpec(A(), spec.id, { parentSpecId: other.spec.id })).toMatchObject({ ok: false, status: 404 });
    expect(await relateSpec(A(), spec.id, { parentSpecId: '00000000-0000-4000-8000-000000000000' })).toMatchObject({ ok: false, status: 404 });
    expect(await relateSpec({ kind: 'user', userId: userB }, spec.id, { parentSpecId: null })).toMatchObject({ ok: false, status: 404 });
    expect(await relateSpec(A(), spec.id, { parentSpecId: 'nope' })).toMatchObject({ ok: false, status: 400 });
  });
});

describe('nothing here approves', () => {
  test('an agent asking for status approved on create, revise or relate still leaves a draft with no approver', async () => {
    const created = await createSpecDraft(agent(), { workspaceId: wsA, title: `Agent ${rand()}`, body: BODY_1, status: 'approved', approvedBy: 'agent' } as any);
    if (!created.ok) throw new Error(created.error);
    const revised = await reviseSpecDraft(agent(), created.spec.id, { expectedVersion: 1, body: BODY_1 + 'more\n', status: 'approved' } as any);
    await relateSpec(agent(), created.spec.id, { parentSpecId: null, status: 'approved' } as any);
    expect(revised.ok).toBe(true);
    const [row] = await q<{ status: string; approved: string | null }>(sql`SELECT status, approved_revision AS approved FROM specs WHERE id = ${created.spec.id}::uuid`);
    expect(row).toEqual({ status: 'draft', approved: null });
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM spec_revisions WHERE spec_id = ${created.spec.id}::uuid AND (approved_by IS NOT NULL OR approved_at IS NOT NULL)`);
    expect(n).toBe(0);
  });
});
