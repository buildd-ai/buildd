/**
 * Retiring a Living Spec (living-specs.md §22), against real Postgres: only a
 * person with approval rights retires or restores; a retired spec leaves the
 * index counts and the import confirm list; superseded names a live spec in
 * the same workspace; restore puts back the status it had, and every step is
 * one change row with who and why.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

process.env.AUTH_SECRET ||= 'spec-retire-test-secret';

const { createSpecDraft, listSpecs } = await import('../../src/lib/specs/store');
const { approveSpecRevision } = await import('../../src/lib/specs/approval');
const { retireSpec, restoreSpec, specRetirement } = await import('../../src/lib/specs/retire');
const { specIndexInputs } = await import('../../src/lib/specs/page-view');
const { specIndexView, importedByArea } = await import('../../src/lib/specs/index-view');
const { confirmImportedSpecs } = await import('../../src/lib/specs/import');

const rand = () => Math.random().toString(36).slice(2, 10);
async function person(teamId: string, role: 'owner' | 'admin' | 'member') {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, ${role})`);
  return u.id;
}

let teamA: string; let wsA: string; let wsB: string;
let admin: string; let member: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${wsA}::uuid`);
  ({ workspaceId: wsB } = await seedWorkspace());
  admin = await person(teamA, 'admin');
  member = await person(teamA, 'member');
});

const user = (userId: string) => ({ kind: 'user' as const, userId });
const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
const agentToken = () => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId: teamA, workspaceIds: null, taskScope: { taskId: '00000000-0000-4000-8000-0000000000f1', workspaceId: wsA } } as any });
const apiKey = () => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId: teamA, workspaceIds: null } as any });
const adminOAuth = () => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId: teamA, workspaceIds: null, sessionUserId: admin } as any });

const REASON = 'A duplicate of the checkout spec, imported twice.';

async function draft(workspaceId = wsA, by = member) {
  const r = await createSpecDraft(user(by), { workspaceId, title: `Checkout ${rand()}`, body: `# Checkout\nR-1: Totals are in the shopper's currency ${rand()}.\n` }, { duplicates: false });
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}
async function statusOf(id: string) {
  const [row] = await q<{ status: string }>(sql`SELECT status FROM specs WHERE id = ${id}::uuid`);
  return row.status;
}

describe('only a person with approval rights retires', () => {
  test('an agent token, a bare API key and a plain member get 403, and nothing changes', async () => {
    const spec = await draft();
    for (const caller of [agentToken(), apiKey(), user(member)]) {
      expect(await retireSpec(caller, spec.id, { reason: REASON })).toMatchObject({ ok: false, status: 403 });
    }
    expect(await statusOf(spec.id)).toBe('draft');
    const rows = await q(sql`SELECT 1 FROM spec_metadata_changes WHERE spec_id = ${spec.id}::uuid`);
    expect(rows.length).toBe(0);
  });

  test('another team\'s admin cannot see the spec (404)', async () => {
    const spec = await draft();
    const [{ team_id: teamB }] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${wsB}::uuid`);
    const outsider = await person(teamB, 'admin');
    expect(await retireSpec(user(outsider), spec.id, { reason: REASON })).toMatchObject({ ok: false, status: 404 });
  });

  test('a reason of under 10 characters is a 400', async () => {
    const spec = await draft();
    expect(await retireSpec(user(admin), spec.id, { reason: 'dup' })).toMatchObject({ ok: false, status: 400 });
  });

  test('the admin retires from the dashboard; the change log says who, why and from what', async () => {
    const spec = await draft();
    const r = await retireSpec(user(admin), spec.id, { reason: REASON });
    expect(r.ok && [r.spec.status, r.spec.version]).toEqual(['retired', spec.version + 1]);
    const [row] = await q<{ field: string; previous_value: unknown; new_value: unknown; reason: string; changed_by_kind: string; changed_by: string }>(sql`
      SELECT field, previous_value, new_value, reason, changed_by_kind, changed_by FROM spec_metadata_changes WHERE spec_id = ${spec.id}::uuid`);
    expect(row).toEqual({ field: 'status', previous_value: { status: 'draft' }, new_value: { status: 'retired' }, reason: REASON, changed_by_kind: 'user', changed_by: `user:${admin}` });
    const view = await specRetirement(spec.id);
    expect(view).toMatchObject({ status: 'retired', reason: REASON, supersededBy: null, by: `user:${admin}` });
  });

  test('the admin\'s own OAuth session retires too (it can be undone)', async () => {
    const spec = await draft();
    const r = await retireSpec(adminOAuth(), spec.id, { reason: REASON });
    expect(r.ok && r.spec.status).toBe('retired');
  });

  test('retiring a retired spec is a 409', async () => {
    const spec = await draft();
    await retireSpec(user(admin), spec.id, { reason: REASON });
    expect(await retireSpec(user(admin), spec.id, { reason: REASON })).toMatchObject({ ok: false, status: 409 });
  });
});

describe('superseded by another spec', () => {
  test('names a live spec in the same workspace: itself, another workspace\'s or a retired one is refused', async () => {
    const spec = await draft();
    const [{ team_id: teamB }] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${wsB}::uuid`);
    const other = await draft(wsB, await person(teamB, 'owner'));
    const gone = await draft();
    await retireSpec(user(admin), gone.id, { reason: REASON });
    expect(await retireSpec(user(admin), spec.id, { reason: REASON, supersededBy: spec.id })).toMatchObject({ ok: false, status: 400 });
    expect(await retireSpec(user(admin), spec.id, { reason: REASON, supersededBy: other.id })).toMatchObject({ ok: false, status: 400 });
    expect(await retireSpec(user(admin), spec.id, { reason: REASON, supersededBy: gone.id })).toMatchObject({ ok: false, status: 400 });
    expect(await retireSpec(user(admin), spec.id, { reason: REASON, supersededBy: 'not-a-uuid' })).toMatchObject({ ok: false, status: 400 });
    expect(await statusOf(spec.id)).toBe('draft');
  });

  test('a live replacement makes it superseded, and the view links it', async () => {
    const spec = await draft();
    const next = await draft();
    const r = await retireSpec(user(admin), spec.id, { reason: REASON, supersededBy: next.id });
    expect(r.ok && r.spec.status).toBe('superseded');
    expect(await specRetirement(spec.id)).toMatchObject({ status: 'superseded', supersededBy: { id: next.id, title: next.title } });
  });
});

describe('restore', () => {
  test('puts back the status it had (approved), and logs it', async () => {
    const spec = await draft();
    const a = await approveSpecRevision(user(admin), spec.id, { revision: 1, expectedVersion: 1 });
    if (!a.ok || 'pending' in a) throw new Error('approve failed');
    const r = await retireSpec(user(admin), spec.id, { reason: REASON });
    if (!r.ok) throw new Error(r.error);
    expect(await restoreSpec(agentToken(), spec.id, {})).toMatchObject({ ok: false, status: 403 });
    const back = await restoreSpec(user(admin), spec.id, {});
    expect(back.ok && [back.spec.status, back.spec.approvedRevision]).toEqual(['approved', 1]);
    expect(await specRetirement(spec.id)).toBeNull();
    const rows = await q<{ field: string; new_value: unknown }>(sql`SELECT field, new_value FROM spec_metadata_changes WHERE spec_id = ${spec.id}::uuid ORDER BY created_at, id`);
    expect(rows.map((x) => x.new_value)).toContainEqual({ status: 'approved' });
  });

  test('restoring a spec that is not retired is a 409', async () => {
    const spec = await draft();
    expect(await restoreSpec(user(admin), spec.id, {})).toMatchObject({ ok: false, status: 409 });
  });
});

describe('a retired spec leaves the index and the confirm list', () => {
  test('counts drop and come back on restore; an imported one leaves the confirm batch', async () => {
    const { workspaceId: ws, teamId } = await seedWorkspace();
    await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${ws}::uuid`);
    const owner = await person(teamId, 'owner');
    const s1 = await createSpecDraft(user(owner), { workspaceId: ws, title: `Kept ${rand()}`, body: `# Kept\nR-1: one ${rand()}.\n` }, { duplicates: false });
    const s2 = await createSpecDraft(user(owner), { workspaceId: ws, title: `Imported ${rand()}`, body: `# Imported\nR-1: two ${rand()}.\n` }, {
      duplicates: false,
      imported: { path: 'docs/specs/imported.md', commitSha: 'a'.repeat(40), blobSha: 'b'.repeat(40), prNumber: null, importedAt: new Date().toISOString() },
    });
    if (!s1.ok || !s2.ok) throw new Error('seed failed');
    const read = async () => {
      const l = await listSpecs(user(owner), ws);
      if (!l.ok) throw new Error(l.error);
      const input = await specIndexInputs(ws, l.specs);
      const view = specIndexView(input);
      const counted = [...view.rowsById.values()].filter((r) => r.state).length;
      return { counted, confirmable: importedByArea(input).flatMap((g) => g.specs.map((s) => s.id)) };
    };
    expect(await read()).toEqual({ counted: 2, confirmable: [s2.spec.id] });

    const r = await retireSpec(user(owner), s2.spec.id, { reason: REASON });
    if (!r.ok) throw new Error(r.error);
    expect(await read()).toEqual({ counted: 1, confirmable: [] });
    const c = await confirmImportedSpecs(user(owner), { workspaceId: ws, specIds: [s2.spec.id] });
    expect(c.ok && c.result.skipped.map((x) => x.reason)).toEqual(['retired']);

    const back = await restoreSpec(user(owner), s2.spec.id, {});
    expect(back.ok && back.spec.status).toBe('draft');
    expect(await read()).toEqual({ counted: 2, confirmable: [s2.spec.id] });
  });
});
