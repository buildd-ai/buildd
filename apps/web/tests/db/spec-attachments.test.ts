/**
 * Spec attachments (living-specs.md §21) against real Postgres: an attachment
 * is an artifact linked to a spec under a name, belonging to the revision it
 * was added in. Approving records each binding attachment's artifact revision
 * next to the design pin; replacing one afterwards shows "changed since
 * approval" (AC-104). A reference attachment is listed but never approved or
 * flagged (AC-105). A name that is not attached resolves to nothing, which the
 * renderer shows as missing (AC-106). An agent attaches and reads one; a reader
 * outside the workspace cannot open it (AC-107).
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

process.env.AUTH_SECRET ||= 'spec-attachments-test-secret';

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision } = await import('../../src/lib/specs/approval');
const { attachToSpec, listSpecAttachments, removeSpecAttachment, openSpecAttachment, attachmentSources } = await import('../../src/lib/specs/attachments');
const { specPageView } = await import('../../src/lib/specs/page-view');
const { approvalRequestView } = await import('../../src/lib/specs/approval-view');
const { signSpecApprovalRequest } = await import('../../src/lib/specs/approval-request');

const rand = () => Math.random().toString(36).slice(2, 10);
const ACCOUNT = '00000000-0000-4000-8000-0000000000d7';
const BODY = '# Checkout\n\n![The pay screen](attachment:pay-screen)\n\n- **AC-1** Paying shows the receipt.\n';

let teamId: string; let ws: string; let otherWs: string; let admin: string; let outsider: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId, workspaceId: ws } = await seedWorkspace());
  ({ workspaceId: otherWs } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${ws}::uuid`);
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, 'admin')`);
  admin = u.id;
  const [o] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`o-${rand()}@example.test`}) RETURNING id`);
  outsider = o.id;
});
const user = () => ({ kind: 'user' as const, userId: admin });
const agent = () => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId, workspaceIds: null, taskScope: { taskId: '00000000-0000-4000-8000-0000000000d8', workspaceId: ws } } as any });
const stranger = () => ({ kind: 'user' as const, userId: outsider });

/** An uploaded image artifact (a file body: storage key per revision). */
async function image(workspaceId = ws, title = 'Pay screen') {
  const [a] = await q<{ id: string; current_revision: number }>(sql`
    INSERT INTO artifacts (workspace_id, type, title, storage_key, metadata, upload_state)
    VALUES (${workspaceId}::uuid, 'file', ${title}, ${`artifacts/${workspaceId}/${rand()}/pay.png`},
      ${JSON.stringify({ filename: 'pay.png', mimeType: 'image/png', sizeBytes: 10 })}::jsonb, 'ready')
    RETURNING id, current_revision`);
  return a;
}
const replaceBytes = (id: string, workspaceId = ws) => q(sql`UPDATE artifacts SET storage_key = ${`artifacts/${workspaceId}/${rand()}/pay.png`}, updated_at = now() WHERE id = ${id}::uuid`);
async function notes() {
  const [a] = await q<{ id: string }>(sql`INSERT INTO artifacts (workspace_id, type, title, content) VALUES (${ws}::uuid, 'content', 'Research notes', 'v1') RETURNING id`);
  return a;
}

async function draft(body = BODY) {
  const d = await createSpecDraft(user(), { workspaceId: ws, title: `Checkout ${rand()}`, body }, { duplicates: false });
  if (!d.ok) throw new Error(d.error);
  return d;
}

describe('attaching', () => {
  test('attach records name, kind, caption, who and the revision; a bad name, kind, a duplicate live name or another workspace\'s artifact is refused', async () => {
    const d = await draft();
    const img = await image();
    const r = await attachToSpec(user(), d.spec.id, { name: 'pay-screen', kind: 'binding', caption: 'The pay screen', artifactId: img.id });
    if (!r.ok) throw new Error(r.error);
    expect(r.attachment).toMatchObject({ name: 'pay-screen', kind: 'binding', caption: 'The pay screen', artifactId: img.id, addedInRevision: 1, addedBy: { kind: 'person' }, isImage: true });
    expect(r.attachment.url).toBe(`/api/specs/${d.spec.id}/attachments/pay-screen?revision=1`);

    expect(await attachToSpec(user(), d.spec.id, { name: 'Pay Screen!', kind: 'binding', artifactId: img.id })).toMatchObject({ ok: false, status: 400 });
    expect(await attachToSpec(user(), d.spec.id, { name: 'x', kind: 'normative', artifactId: img.id })).toMatchObject({ ok: false, status: 400 });
    expect(await attachToSpec(user(), d.spec.id, { name: 'pay-screen', kind: 'binding', artifactId: img.id })).toMatchObject({ ok: false, status: 409 });
    const foreign = await image(otherWs);
    expect(await attachToSpec(user(), d.spec.id, { name: 'foreign', kind: 'reference', artifactId: foreign.id })).toMatchObject({ ok: false, status: 400 });
    // Nothing else was written.
    const rows = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM spec_attachments WHERE spec_id = ${d.spec.id}::uuid`);
    expect(rows[0]!.n).toBe(1);
  });

  test('an attachment belongs to the revision it was added in; a removal stops it from a later revision but older ones keep it', async () => {
    const d = await draft();
    const img = await image();
    const a1 = await attachToSpec(user(), d.spec.id, { name: 'pay-screen', kind: 'binding', artifactId: img.id });
    if (!a1.ok) throw new Error(a1.error);
    const ap = await approveSpecRevision(user(), d.spec.id, { revision: 1, expectedVersion: d.spec.version });
    if (!ap.ok || !('revision' in ap)) throw new Error('approve');
    const r2 = await reviseSpecDraft(user(), d.spec.id, { expectedVersion: ap.spec.version, body: `${BODY}- **AC-2** A refund shows a note.\n` });
    if (!r2.ok) throw new Error(r2.error);
    const late = await attachToSpec(user(), d.spec.id, { name: 'refund-note', kind: 'reference', artifactId: (await notes()).id });
    if (!late.ok) throw new Error(late.error);
    expect(late.attachment.addedInRevision).toBe(2);

    const rm = await removeSpecAttachment(user(), d.spec.id, 'pay-screen');
    if (!rm.ok) throw new Error(rm.error);
    expect(rm.removedFromRevision).toBe(2);
    const on1 = await listSpecAttachments(user(), d.spec.id, { revision: 1 });
    const on2 = await listSpecAttachments(user(), d.spec.id, { revision: 2 });
    expect(on1.ok && on1.attachments.map((a) => a.name)).toEqual(['pay-screen']);
    expect(on2.ok && on2.attachments.map((a) => a.name)).toEqual(['refund-note']);
    // The name is free again once removed.
    expect((await attachToSpec(user(), d.spec.id, { name: 'pay-screen', kind: 'binding', artifactId: img.id })).ok).toBe(true);
    expect(await removeSpecAttachment(user(), d.spec.id, 'never-attached')).toMatchObject({ ok: false, status: 404 });
  });
});

describe('removing from an approved head', () => {
  test('the approved revision keeps what it was approved with; the removal applies from the next revision', async () => {
    const d = await draft();
    const img = await image();
    const a = await attachToSpec(user(), d.spec.id, { name: 'pay-screen', kind: 'binding', artifactId: img.id });
    if (!a.ok) throw new Error(a.error);
    const ap = await approveSpecRevision(user(), d.spec.id, { revision: 1, expectedVersion: d.spec.version });
    if (!ap.ok) throw new Error(ap.error);
    const rm = await removeSpecAttachment(user(), d.spec.id, 'pay-screen');
    expect(rm).toEqual({ ok: true, removedFromRevision: 2 });
    const on1 = await listSpecAttachments(user(), d.spec.id, { revision: 1 });
    expect(on1.ok && on1.attachments.map((x) => [x.name, x.approval?.state])).toEqual([['pay-screen', 'unchanged']]);
    expect(await removeSpecAttachment(agent(), d.spec.id, 'pay-screen')).toMatchObject({ ok: false, status: 404 });
  });
});

describe('approval records binding attachments', () => {
  test('AC-104: approving records the binding image\'s revision; replacing it shows changed since approval on the page; the approval page renders it inline', async () => {
    const d = await draft();
    const img = await image();
    const a = await attachToSpec(user(), d.spec.id, { name: 'pay-screen', kind: 'binding', caption: 'The pay screen', artifactId: img.id });
    if (!a.ok) throw new Error(a.error);

    // The approval page (a request made over MCP) resolves the inline image.
    const token = signSpecApprovalRequest({ specId: d.spec.id, workspaceId: ws, revision: 1, expectedVersion: d.spec.version, contentHash: d.revision.contentHash, requestedBy: admin }, Date.now());
    if (!token) throw new Error('approval links not configured');
    const req = await approvalRequestView(admin, d.spec.id, token);
    expect(req.state === 'ready' && req.attachments?.['pay-screen']?.src).toBe(`/api/specs/${d.spec.id}/attachments/pay-screen?revision=1`);

    const ap = await approveSpecRevision(user(), d.spec.id, { revision: 1, expectedVersion: d.spec.version });
    if (!ap.ok || !('revision' in ap)) throw new Error('approve');
    expect(ap.revision.approvedAttachments).toEqual([{ attachmentId: a.attachment.id, name: 'pay-screen', artifactId: img.id, revision: img.current_revision }]);

    const before = await specPageView(admin, d.spec.id);
    if (before.state !== 'ok') throw new Error('not found');
    expect(before.attachments.map((x) => [x.name, x.approval?.state])).toEqual([['pay-screen', 'unchanged']]);
    expect(before.attachmentSources['pay-screen']).toMatchObject({ src: `/api/specs/${d.spec.id}/attachments/pay-screen?revision=1`, image: true });

    await replaceBytes(img.id);
    const after = await specPageView(admin, d.spec.id);
    if (after.state !== 'ok') throw new Error('not found');
    expect(after.attachments[0]!.approval).toEqual({ state: 'changed', pinned: img.current_revision, current: img.current_revision + 1 });
    // The approval record itself never moves.
    const [rev] = await q<{ approved_attachments: unknown }>(sql`SELECT approved_attachments FROM spec_revisions WHERE spec_id = ${d.spec.id}::uuid AND revision = 1`);
    expect(rev!.approved_attachments).toEqual([{ attachmentId: a.attachment.id, name: 'pay-screen', artifactId: img.id, revision: img.current_revision }]);
  });

  test('replacing a binding attachment with another artifact under the same name shows changed since approval', async () => {
    const d = await draft();
    const first = await image();
    const a = await attachToSpec(user(), d.spec.id, { name: 'pay-screen', kind: 'binding', artifactId: first.id });
    if (!a.ok) throw new Error(a.error);
    const ap = await approveSpecRevision(user(), d.spec.id, { revision: 1, expectedVersion: d.spec.version });
    if (!ap.ok) throw new Error(ap.error);
    const second = await image(ws, 'Pay screen v2');
    const r = await attachToSpec(user(), d.spec.id, { name: 'pay-screen', kind: 'binding', artifactId: second.id, replace: true });
    if (!r.ok) throw new Error(r.error);
    const page = await specPageView(admin, d.spec.id);
    if (page.state !== 'ok') throw new Error('not found');
    expect(page.attachments.map((x) => [x.name, x.artifactId, x.approval?.state])).toEqual([['pay-screen', second.id, 'changed']]);
  });

  test('AC-105: a reference attachment is listed under Files, is not in the approval record, and changing it warns nothing', async () => {
    const d = await draft();
    const n = await notes();
    const r = await attachToSpec(agent(), d.spec.id, { name: 'research', kind: 'reference', caption: 'Interview notes', artifactId: n.id });
    if (!r.ok) throw new Error(r.error);
    const ap = await approveSpecRevision(user(), d.spec.id, { revision: 1, expectedVersion: d.spec.version });
    if (!ap.ok || !('revision' in ap)) throw new Error('approve');
    expect(ap.revision.approvedAttachments).toEqual([]);
    await q(sql`UPDATE artifacts SET content = 'v2', updated_at = now() WHERE id = ${n.id}::uuid`);
    const page = await specPageView(admin, d.spec.id);
    if (page.state !== 'ok') throw new Error('not found');
    expect(page.attachments.map((x) => [x.name, x.kind, x.caption, x.addedBy.kind, x.approval])).toEqual([['research', 'reference', 'Interview notes', 'agent', null]]);
  });

  test('a binding attachment added after approval reads as added since approval', async () => {
    const d = await draft();
    const ap = await approveSpecRevision(user(), d.spec.id, { revision: 1, expectedVersion: d.spec.version });
    if (!ap.ok) throw new Error(ap.error);
    const img = await image();
    const r = await attachToSpec(user(), d.spec.id, { name: 'pay-screen', kind: 'binding', artifactId: img.id });
    if (!r.ok) throw new Error(r.error);
    const page = await specPageView(admin, d.spec.id);
    if (page.state !== 'ok') throw new Error('not found');
    expect(page.attachments[0]!.approval).toEqual({ state: 'added', pinned: null, current: img.current_revision });
  });
});

describe('inline references and access', () => {
  test('AC-106: a name the revision does not attach has no source, so it renders as missing', async () => {
    const d = await draft();
    const sources = await attachmentSources(d.spec.id, 1);
    expect(sources['pay-screen']).toBeUndefined();
    const page = await specPageView(admin, d.spec.id);
    if (page.state !== 'ok') throw new Error('not found');
    expect(page.attachmentSources).toEqual({});
  });

  test('AC-107: an agent attaches an image and reads it back; a reader outside the workspace cannot open it', async () => {
    const d = await draft();
    const img = await image();
    const r = await attachToSpec(agent(), d.spec.id, { name: 'pay-screen', kind: 'binding', artifactId: img.id });
    if (!r.ok) throw new Error(r.error);
    const listed = await listSpecAttachments(agent(), d.spec.id, {});
    expect(listed.ok && listed.attachments.map((a) => [a.name, a.artifactId, a.addedBy.kind])).toEqual([['pay-screen', img.id, 'agent']]);
    const open = await openSpecAttachment(agent(), d.spec.id, 'pay-screen', {});
    expect(open).toMatchObject({ ok: true, artifactId: img.id });

    // Outside the workspace: the spec, its list and the link are all not found.
    expect(await openSpecAttachment(stranger(), d.spec.id, 'pay-screen', {})).toMatchObject({ ok: false, status: 404 });
    expect(await listSpecAttachments(stranger(), d.spec.id, {})).toMatchObject({ ok: false, status: 404 });
    expect(await attachToSpec(stranger(), d.spec.id, { name: 'x', kind: 'reference', artifactId: img.id })).toMatchObject({ ok: false, status: 404 });
    // A task token for another workspace cannot read it either.
    const elsewhere = { kind: 'account' as const, account: { id: ACCOUNT, teamId, workspaceIds: null, taskScope: { taskId: '00000000-0000-4000-8000-0000000000d9', workspaceId: otherWs } } as any };
    expect(await openSpecAttachment(elsewhere, d.spec.id, 'pay-screen', {})).toMatchObject({ ok: false, status: 404 });
  });

  test('a person can start an upload: a pending artifact in the spec\'s workspace, attached under the name', async () => {
    const d = await draft();
    const r = await attachToSpec(user(), d.spec.id, { name: 'flow', kind: 'binding', filename: 'flow.png', mimeType: 'image/png', sizeBytes: 1234 }, {
      signUpload: async (key) => `https://upload.test/${key}`,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.upload?.uploadUrl).toStartWith('https://upload.test/');
    const [art] = await q<{ workspace_id: string; upload_state: string; storage_key: string }>(sql`SELECT workspace_id, upload_state, storage_key FROM artifacts WHERE id = ${r.attachment.artifactId}::uuid`);
    expect(art).toMatchObject({ workspace_id: ws, upload_state: 'pending' });
    // Signed for the staging key, never the key readers are served (lib/artifact-upload.ts).
    expect(r.upload!.uploadUrl).toBe(`https://upload.test/${art!.storage_key}.upload`);
    expect(await attachToSpec(user(), d.spec.id, { name: 'big', kind: 'binding', filename: 'b.png', mimeType: 'image/png', sizeBytes: 60 * 1024 * 1024 }, { signUpload: async () => 'x' })).toMatchObject({ ok: false, status: 400 });
  });
});
