/**
 * Copying a Living Spec into another workspace (apps/web/src/lib/specs/copy.ts,
 * living-specs.md §25), against real Postgres: the handoff a runner in the
 * destination waits on. A copy grants no access and approves nothing; its
 * reply is the verified destination spec id, revision and hash, or a refusal
 * by name; a retry never duplicates.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { createSpecDraft, reviseSpecDraft, getSpec } = await import('../../src/lib/specs/store');
const { copySpecToWorkspace, specNotFound } = await import('../../src/lib/specs/copy');
const { pinSpecSource } = await import('../../src/lib/specs/pin');

const rand = () => Math.random().toString(36).slice(2, 10);
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
async function member(teamId: string) {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, 'member')`);
  return u.id;
}
async function workspaceIn(teamId: string) {
  const [ws] = await q<{ id: string }>(sql`INSERT INTO workspaces (name, team_id, access_mode) VALUES (${`w-${rand()}`}, ${teamId}::uuid, 'open') RETURNING id`);
  return ws.id;
}
/** Approve a revision the way the approval statement leaves it (a person's act, outside this suite). */
async function approve(specId: string, revision: number) {
  await q(sql`UPDATE spec_revisions SET approved_at = now(), approved_by = 'user:test' WHERE spec_id = ${specId}::uuid AND revision = ${revision}`);
  await q(sql`UPDATE specs SET approved_revision = ${revision}, status = 'approved' WHERE id = ${specId}::uuid`);
}

// Team T has the source workspace and the destination; the person is in both.
// Team O is another team: its workspace is not the person's to write.
let teamT: string; let source: string; let dest: string; let person: string; let outsider: string; let otherWs: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamT, workspaceId: source } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${source}::uuid`);
  dest = await workspaceIn(teamT);
  person = await member(teamT);
  let teamO: string;
  ({ teamId: teamO, workspaceId: otherWs } = await seedWorkspace());
  outsider = await member(teamO);
});
const P = () => ({ kind: 'user' as const, userId: person });

const BODY_1 = '# Operator surface\nR-1: Root causes are read through the operator API.\n- **AC-1** The team product shows no incident list.\n';
const BODY_2 = BODY_1 + 'R-2: Stranded-at-gate counts stay visible to the operator.\n';

/** A spec at revision 2, revision 2 approved: the shape of the handoff that failed. */
async function sourceSpec() {
  const c = await createSpecDraft(P(), { workspaceId: source, title: `Operator surface ${rand()}`, body: BODY_1 }, { duplicates: false });
  if (!c.ok) throw new Error(c.error);
  const r = await reviseSpecDraft(P(), c.spec.id, { expectedVersion: 1, body: BODY_2 });
  if (!r.ok) throw new Error(r.error);
  await approve(c.spec.id, 2);
  return c.spec.id;
}
const count = async (workspaceId: string) => (await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM specs WHERE workspace_id = ${workspaceId}::uuid`))[0].n;

describe('a successful copy', () => {
  test('writes the approved revision byte for byte as an unapproved draft and reports the verified destination', async () => {
    const specId = await sourceSpec();
    const r = await copySpecToWorkspace(P(), specId, { targetWorkspaceId: dest, revision: 2 });
    if (!r.ok) throw new Error(r.error);
    expect(r.verified).toBe(true);
    expect(r.reused).toBe(false);
    expect(r.source).toMatchObject({ workspaceId: source, specId, revision: 2, contentHash: sha(BODY_2), approved: true });
    expect(r.destination).toMatchObject({ workspaceId: dest, revision: 1, contentHash: sha(BODY_2), approved: false, status: 'draft' });
    expect(r.destination.specId).not.toBe(specId);

    const got = await getSpec(P(), r.destination.specId);
    expect(got.ok && got.view.body).toBe(BODY_2);
    expect(got.ok && [got.view.spec.workspaceId, got.view.spec.approvedRevision, got.view.spec.metadata?.copied_from?.specId]).toEqual([dest, null, specId]);
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM spec_revisions WHERE spec_id = ${r.destination.specId}::uuid AND approved_at IS NOT NULL`);
    expect(n).toBe(0);
  });

  test('with no revision named, the approved one is copied', async () => {
    const specId = await sourceSpec();
    const r = await copySpecToWorkspace(P(), specId, { targetWorkspaceId: dest });
    expect(r.ok && [r.source.revision, r.destination.contentHash]).toEqual([2, sha(BODY_2)]);
  });

  test('the destination can then pin the copy, provisionally, and a pin of the source id names the copy', async () => {
    const specId = await sourceSpec();
    const r = await copySpecToWorkspace(P(), specId, { targetWorkspaceId: dest, revision: 2 });
    if (!r.ok) throw new Error(r.error);
    const pinned = await pinSpecSource(dest, { specSource: { specId: r.destination.specId, revision: 1 } });
    expect(pinned.ok && (pinned.context as any).specSource).toMatchObject({ specId: r.destination.specId, revision: 1, contentHash: sha(BODY_2), provisional: true });
    const foreign = await pinSpecSource(dest, { specSource: { specId } });
    expect(foreign).toMatchObject({ ok: false, status: 404 });
    expect(!foreign.ok && foreign.error).toContain(r.destination.specId);
  });
});

describe('a destination runner that cannot read the source', () => {
  test('gets a 404 that names the copy it can read, by full or short id', async () => {
    const specId = await sourceSpec();
    const r = await copySpecToWorkspace(P(), specId, { targetWorkspaceId: dest, revision: 2 });
    if (!r.ok) throw new Error(r.error);
    // A task token scoped to the destination: the runner that kept getting 404.
    const runner = { kind: 'account' as const, account: { id: '00000000-0000-4000-8000-0000000000c1', teamId: teamT, workspaceIds: null, taskScope: { workspaceId: dest } } as any };
    expect(await getSpec(runner, specId)).toMatchObject({ ok: false, status: 404 });
    for (const id of [specId, specId.slice(0, 8)]) {
      const nf = await specNotFound(runner, id);
      expect(nf).toMatchObject({ status: 404, code: 'spec_copied' });
      expect(nf.error).toContain(r.destination.specId);
      expect(nf.error).toContain(sha(BODY_2));
    }
  });

  test('with no copy, the 404 says how one is made and never shows the source', async () => {
    const specId = await sourceSpec();
    const runner = { kind: 'account' as const, account: { id: '00000000-0000-4000-8000-0000000000c2', teamId: teamT, workspaceIds: null, taskScope: { workspaceId: dest } } as any };
    const nf = await specNotFound(runner, specId);
    expect(nf).toMatchObject({ status: 404, code: 'spec_not_found' });
    expect(nf.error).toContain('action: "copy"');
    expect(nf.error).not.toContain('Operator surface');
    const pin = await pinSpecSource(dest, { specSource: { specId } });
    expect(!pin.ok && pin.error).toContain('action: "copy"');
  });
});

describe('an inaccessible destination', () => {
  test('another team\'s workspace is refused by name and nothing is written there', async () => {
    const specId = await sourceSpec();
    const before = await count(otherWs);
    const r = await copySpecToWorkspace(P(), specId, { targetWorkspaceId: otherWs, revision: 2 });
    expect(r).toMatchObject({ ok: false, status: 404, code: 'spec_copy_destination' });
    expect(await count(otherWs)).toBe(before);
  });

  test('a task token reaches only its own workspace, so it cannot copy across', async () => {
    const specId = await sourceSpec();
    const token = { kind: 'account' as const, account: { id: '00000000-0000-4000-8000-0000000000c3', teamId: teamT, workspaceIds: null, taskScope: { workspaceId: source } } as any };
    const before = await count(dest);
    expect(await copySpecToWorkspace(token, specId, { targetWorkspaceId: dest })).toMatchObject({ ok: false, status: 404, code: 'spec_copy_destination' });
    expect(await count(dest)).toBe(before);
  });

  test('a caller who cannot read the source gets the plain 404, not the spec', async () => {
    const specId = await sourceSpec();
    const r = await copySpecToWorkspace({ kind: 'user', userId: outsider }, specId, { targetWorkspaceId: otherWs });
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(!r.ok && r.error).not.toContain('Operator surface');
  });
});

describe('a stale revision', () => {
  test('a revision older than the approved one, one the spec does not have, or a hash not the one read is refused and writes nothing', async () => {
    const specId = await sourceSpec();
    const before = await count(dest);
    expect(await copySpecToWorkspace(P(), specId, { targetWorkspaceId: dest, revision: 1 })).toMatchObject({ ok: false, status: 409, code: 'spec_copy_stale' });
    expect(await copySpecToWorkspace(P(), specId, { targetWorkspaceId: dest, revision: 3 })).toMatchObject({ ok: false, status: 409, code: 'spec_copy_stale' });
    expect(await copySpecToWorkspace(P(), specId, { targetWorkspaceId: dest, revision: 2, expectedContentHash: sha(BODY_1) })).toMatchObject({ ok: false, status: 409, code: 'spec_copy_stale' });
    expect(await count(dest)).toBe(before);
    const ok = await copySpecToWorkspace(P(), specId, { targetWorkspaceId: dest, revision: 2, expectedContentHash: sha(BODY_2) });
    expect(ok.ok).toBe(true);
  });
});

describe('failure', () => {
  test('bad input, the same workspace, and a retired source are refused and write nothing', async () => {
    const specId = await sourceSpec();
    const before = await count(dest);
    expect(await copySpecToWorkspace(P(), specId, { targetWorkspaceId: 'buildd-admin' })).toMatchObject({ ok: false, status: 400 });
    expect(await copySpecToWorkspace(P(), specId, { targetWorkspaceId: source })).toMatchObject({ ok: false, status: 400 });
    expect(await copySpecToWorkspace(P(), specId, { targetWorkspaceId: dest, revision: 0 })).toMatchObject({ ok: false, status: 400 });
    await q(sql`UPDATE specs SET status = 'retired' WHERE id = ${specId}::uuid`);
    expect(await copySpecToWorkspace(P(), specId, { targetWorkspaceId: dest })).toMatchObject({ ok: false, status: 409, code: 'spec_copy_retired' });
    expect(await count(dest)).toBe(before);
  });

  test('a source body that no longer matches its hash is refused, never copied as some other text', async () => {
    const specId = await sourceSpec();
    await q(sql`UPDATE spec_revisions SET content_hash = ${'0'.repeat(64)} WHERE spec_id = ${specId}::uuid AND revision = 2`);
    const before = await count(dest);
    expect(await copySpecToWorkspace(P(), specId, { targetWorkspaceId: dest, revision: 2 })).toMatchObject({ ok: false, status: 409, code: 'spec_copy_source_unreadable' });
    expect(await count(dest)).toBe(before);
  });
});

describe('retry', () => {
  test('copying again returns the same verified spec and writes nothing new', async () => {
    const specId = await sourceSpec();
    const first = await copySpecToWorkspace(P(), specId, { targetWorkspaceId: dest, revision: 2 });
    const before = await count(dest);
    const again = await copySpecToWorkspace(P(), specId, { targetWorkspaceId: dest, revision: 2 });
    if (!first.ok || !again.ok) throw new Error('copy failed');
    expect([again.reused, again.destination.specId, again.destination.revision, again.destination.version]).toEqual([true, first.destination.specId, 1, 1]);
    expect(await count(dest)).toBe(before);
  });

  test('after the source moves on, copying the new revision revises the copy instead of making a second one', async () => {
    const specId = await sourceSpec();
    const first = await copySpecToWorkspace(P(), specId, { targetWorkspaceId: dest, revision: 2 });
    if (!first.ok) throw new Error(first.error);
    const body3 = BODY_2 + 'R-3: Owner verdicts are kept.\n';
    const rev = await reviseSpecDraft(P(), specId, { expectedVersion: 2, body: body3 });
    if (!rev.ok) throw new Error(rev.error);
    await approve(specId, 3);
    const before = await count(dest);
    const next = await copySpecToWorkspace(P(), specId, { targetWorkspaceId: dest });
    if (!next.ok) throw new Error(next.error);
    expect([next.reused, next.destination.specId, next.destination.revision, next.destination.contentHash, next.source.revision]).toEqual([false, first.destination.specId, 2, sha(body3), 3]);
    expect(await count(dest)).toBe(before);
    const got = await getSpec(P(), first.destination.specId);
    expect(got.ok && [got.view.body, got.view.spec.metadata?.copied_from?.revision]).toEqual([body3, 3]);
  });

  test('a copy whose provenance write was lost is repaired by the retry', async () => {
    const specId = await sourceSpec();
    const first = await copySpecToWorkspace(P(), specId, { targetWorkspaceId: dest, revision: 2 });
    if (!first.ok) throw new Error(first.error);
    await q(sql`UPDATE specs SET metadata = jsonb_set(metadata, '{copied_from,revision}', '1'::jsonb) WHERE id = ${first.destination.specId}::uuid`);
    const again = await copySpecToWorkspace(P(), specId, { targetWorkspaceId: dest, revision: 2 });
    expect(again.ok && [again.reused, again.destination.specId]).toEqual([true, first.destination.specId]);
    const got = await getSpec(P(), first.destination.specId);
    expect(got.ok && got.view.spec.metadata?.copied_from?.revision).toBe(2);
  });
});
