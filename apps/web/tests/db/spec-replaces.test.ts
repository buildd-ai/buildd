/**
 * A draft that names the specs it replaces, and approving it ("Retiring a
 * spec" R-76, R-77; "finding and organising specs" R-100, AC-137), against
 * real Postgres:
 * - `replaces` is stored on the revision as data; an agent may set it; a
 *   replaced spec must be live and in the same workspace, else 400;
 * - approving with the default choice approves B and supersedes A, two change
 *   rows, the retirement naming the approval; unchecked approves only;
 * - an OAuth approve returns a link that carries the choice, confirmed by the
 *   person; a replaced spec that moved between render and confirm is reported
 *   stale and the approval stands;
 * - the pages: A says a replacement is waiting, B says what it replaces, and
 *   the review sheet lists A for "Retire it".
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

process.env.AUTH_SECRET ||= 'spec-replaces-test-secret';

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision, confirmSpecApproval } = await import('../../src/lib/specs/approval');
const { verifySpecApprovalRequest } = await import('../../src/lib/specs/approval-request');
const { approvalRequestView } = await import('../../src/lib/specs/approval-view');
const { retireSpec, specRetirement, retireDeps } = await import('../../src/lib/specs/retire');
const { specApprovalDeps } = await import('../../src/lib/specs/approval');
const { specPageView, specReviewView } = await import('../../src/lib/specs/page-view');

// No after-response work here: no index, no repo PR.
specApprovalDeps.afterResponse = () => {};
retireDeps.afterResponse = () => {};

const rand = () => Math.random().toString(36).slice(2, 10);
async function person(teamId: string, role: 'owner' | 'admin' | 'member') {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, ${role})`);
  return u.id;
}

let teamA: string; let wsA: string; let wsB: string;
let admin: string; let member: string; let adminB: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${wsA}::uuid`);
  let teamB: string;
  ({ teamId: teamB, workspaceId: wsB } = await seedWorkspace());
  admin = await person(teamA, 'admin');
  adminB = await person(teamB, 'admin');
  member = await person(teamA, 'member');
});

const user = (userId: string) => ({ kind: 'user' as const, userId });
const ACCOUNT = '00000000-0000-4000-8000-0000000000a3';
const agentToken = () => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId: teamA, workspaceIds: null, taskScope: { taskId: '00000000-0000-4000-8000-0000000000f3', workspaceId: wsA } } as any });
const apiKey = () => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId: teamA, workspaceIds: null } as any });
const adminOAuth = () => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId: teamA, workspaceIds: null, sessionUserId: admin } as any });

const body = (t: string) => `# ${t}\nR-1: Totals are in the shopper's currency ${rand()}.\n`;

async function spec(workspaceId = wsA, extra: Record<string, unknown> = {}, caller: any = user(member)) {
  const title = `Checkout ${rand()}`;
  const r = await createSpecDraft(caller, { workspaceId, title, body: body(title), ...extra }, { duplicates: false });
  if (!r.ok) throw new Error(`${r.status} ${r.error}`);
  return r;
}
async function approved(workspaceId = wsA) {
  // Each workspace's own people write and approve there.
  const [writer, approver] = workspaceId === wsA ? [member, admin] : [adminB, adminB];
  const r = await spec(workspaceId, {}, user(writer));
  const a = await approveSpecRevision(user(approver), r.spec.id, { revision: 1, expectedVersion: r.spec.version });
  if (!a.ok || 'pending' in a) throw new Error('approve failed');
  return a.spec;
}
const row = async (id: string) => (await q<{ status: string; version: number }>(sql`SELECT status, version FROM specs WHERE id = ${id}::uuid`))[0];
const statusRows = (id: string) => q<{ new_value: any; reason: string; changed_by: string }>(sql`SELECT new_value, reason, changed_by FROM spec_metadata_changes WHERE spec_id = ${id}::uuid AND field = 'status' ORDER BY created_at`);
const replacesOf = async (id: string, revision: number) => (await q<{ replaces: string[] | null }>(sql`SELECT replaces FROM spec_revisions WHERE spec_id = ${id}::uuid AND revision = ${revision}`))[0].replaces;

describe('R-76: a draft names the specs it replaces, as data', () => {
  test('AC-123: an agent token creates a draft naming replaces; the field is on the revision; retire is a 403', async () => {
    const a = await approved();
    const b = await spec(wsA, { replaces: [a.id] }, agentToken());
    expect(await replacesOf(b.spec.id, 1)).toEqual([a.id]);
    for (const caller of [agentToken(), apiKey()]) {
      expect(await retireSpec(caller, a.id, { reason: 'Replaced by the new checkout spec.', supersededBy: b.spec.id })).toMatchObject({ ok: false, status: 403 });
    }
    expect((await row(a.id)).status).toBe('approved');
  });

  test('create_draft\'s supersedes writes the same field', async () => {
    const a = await approved();
    const b = await spec(wsA, { supersedes: a.id });
    expect(await replacesOf(b.spec.id, 1)).toEqual([a.id]);
  });

  test('another workspace\'s spec, a retired one or a missing id is a 400 and nothing is written', async () => {
    const other = await approved(wsB);
    const gone = await approved();
    expect((await retireSpec(user(admin), gone.id, { reason: 'No longer needed at all.' })).ok).toBe(true);
    const before = (await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM specs WHERE workspace_id = ${wsA}::uuid`))[0].n;
    for (const replaces of [[other.id], [gone.id], ['00000000-0000-4000-8000-00000000dead'], ['not-a-uuid'], 'x']) {
      const r = await createSpecDraft(user(member), { workspaceId: wsA, title: `T ${rand()}`, body: body('T'), replaces }, { duplicates: false });
      expect(r).toMatchObject({ ok: false, status: 400 });
    }
    expect((await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM specs WHERE workspace_id = ${wsA}::uuid`))[0].n).toBe(before);
  });

  test('revise: omitted keeps the head\'s, a change alone is a new revision, itself is a 400, [] clears', async () => {
    const a = await approved();
    const a2 = await approved();
    const b = await spec(wsA, { replaces: [a.id] });
    const text = await q<{ content: string }>(sql`SELECT content FROM artifacts WHERE id = ${b.spec.bodyArtifactId}::uuid`);
    const r1 = await reviseSpecDraft(user(member), b.spec.id, { expectedVersion: b.spec.version, body: `${text[0].content}R-2: More.\n` }, { duplicates: false });
    if (!r1.ok) throw new Error(r1.error);
    expect(await replacesOf(b.spec.id, 2)).toEqual([a.id]);
    const self = await reviseSpecDraft(user(member), b.spec.id, { expectedVersion: r1.spec.version, body: `${text[0].content}R-2: More.\n`, replaces: [b.spec.id] }, { duplicates: false });
    expect(self).toMatchObject({ ok: false, status: 400 });
    const r2 = await reviseSpecDraft(user(member), b.spec.id, { expectedVersion: r1.spec.version, body: `${text[0].content}R-2: More.\n`, replaces: [a.id, a2.id] }, { duplicates: false });
    if (!r2.ok) throw new Error(r2.error);
    expect([r2.unchanged, r2.revision.revision]).toEqual([false, 3]);
    expect(await replacesOf(b.spec.id, 3)).toEqual([a.id, a2.id]);
    const r3 = await reviseSpecDraft(user(member), b.spec.id, { expectedVersion: r2.spec.version, body: `${text[0].content}R-2: More.\n`, replaces: [] }, { duplicates: false });
    if (!r3.ok) throw new Error(r3.error);
    expect(await replacesOf(b.spec.id, 4)).toBeNull();
  });
});

describe('R-77: approving the replacement offers to retire what it replaces', () => {
  test('AC-122: the default choice approves B, supersedes A by B, and two change rows exist', async () => {
    const a = await approved();
    const b = await spec(wsA, { replaces: [a.id] });
    const r = await approveSpecRevision(user(admin), b.spec.id, { revision: 1, expectedVersion: b.spec.version });
    if (!r.ok || 'pending' in r) throw new Error('approve failed');
    expect(r.spec.status).toBe('approved');
    expect(r.retirements).toEqual([{ specId: a.id, title: a.title, state: 'superseded' }]);
    expect((await row(a.id)).status).toBe('superseded');
    const rows = await statusRows(a.id);
    expect(rows.length).toBe(1);
    expect(rows[0].new_value).toMatchObject({ status: 'superseded', supersededBy: b.spec.id, approval: { specId: b.spec.id, revision: 1 } });
    expect(rows[0].changed_by).toBe(`user:${admin}`);
    // The second change: B's approval, stamped on its revision by the same person.
    const [rev] = await q<{ approved_by: string }>(sql`SELECT approved_by FROM spec_revisions WHERE spec_id = ${b.spec.id}::uuid AND revision = 1`);
    expect(rev.approved_by).toBe(`user:${admin}`);
    expect((await specRetirement(a.id))?.supersededBy?.id).toBe(b.spec.id);
  });

  test('AC-122: unchecked approves B only', async () => {
    const a = await approved();
    const b = await spec(wsA, { replaces: [a.id] });
    const r = await approveSpecRevision(user(admin), b.spec.id, { revision: 1, expectedVersion: b.spec.version, retire: [] });
    if (!r.ok || 'pending' in r) throw new Error('approve failed');
    expect([r.spec.status, r.retirements]).toEqual(['approved', []]);
    expect((await row(a.id)).status).toBe('approved');
    expect((await statusRows(a.id)).length).toBe(0);
  });

  test('retire naming a spec the revision does not replace is a 400, and nothing is approved', async () => {
    const a = await approved();
    const stranger = await approved();
    const b = await spec(wsA, { replaces: [a.id] });
    expect(await approveSpecRevision(user(admin), b.spec.id, { revision: 1, expectedVersion: b.spec.version, retire: [stranger.id] })).toMatchObject({ ok: false, status: 400 });
    expect((await row(b.spec.id)).status).toBe('draft');
  });

  test('an agent token or API key cannot approve, so cannot retire through approval (403)', async () => {
    const a = await approved();
    const b = await spec(wsA, { replaces: [a.id] });
    for (const caller of [agentToken(), apiKey()]) {
      expect(await approveSpecRevision(caller, b.spec.id, { revision: 1, expectedVersion: b.spec.version })).toMatchObject({ ok: false, status: 403 });
    }
    expect((await row(a.id)).status).toBe('approved');
  });

  test('version race: A moved after the sheet was read; B is approved and A reports stale', async () => {
    const a = await approved();
    const b = await spec(wsA, { replaces: [a.id] });
    const readVersion = (await row(a.id)).version;
    // Someone revises A after the approver opened the sheet.
    const aText = await q<{ content: string }>(sql`SELECT content FROM artifacts WHERE id = ${a.bodyArtifactId}::uuid`);
    const moved = await reviseSpecDraft(user(member), a.id, { expectedVersion: readVersion, body: `${aText[0].content}R-2: Late change.\n` }, { duplicates: false });
    expect(moved.ok).toBe(true);
    const r = await approveSpecRevision(user(admin), b.spec.id, { revision: 1, expectedVersion: b.spec.version, retire: [{ specId: a.id, expectedVersion: readVersion }] });
    if (!r.ok || 'pending' in r) throw new Error('approve failed');
    expect(r.spec.status).toBe('approved');
    expect(r.retirements).toMatchObject([{ specId: a.id, state: 'stale' }]);
    expect((await row(a.id)).status).not.toBe('superseded');
    expect((await statusRows(a.id)).length).toBe(0);
  });
});

describe('the OAuth confirmation link carries the choice', () => {
  test('the link carries the default choice at the versions read, and confirming supersedes A', async () => {
    const a = await approved();
    const b = await spec(wsA, { replaces: [a.id] });
    const p = await approveSpecRevision(adminOAuth(), b.spec.id, { revision: 1, expectedVersion: b.spec.version });
    if (!p.ok || !('pending' in p)) throw new Error('expected a pending link');
    const token = new URL(p.pending.confirmUrl).searchParams.get('request')!;
    const v = verifySpecApprovalRequest(token);
    expect(v.ok && v.payload.retire).toEqual([{ specId: a.id, expectedVersion: (await row(a.id)).version }]);
    // Nothing happened yet.
    expect([(await row(b.spec.id)).status, (await row(a.id)).status]).toEqual(['draft', 'approved']);
    const view = await approvalRequestView(admin, b.spec.id, token);
    expect(view.state === 'ready' && view.replacing).toEqual([{ id: a.id, title: a.title, version: (await row(a.id)).version, checked: true }]);
    const c = await confirmSpecApproval(user(admin), b.spec.id, token);
    if (!c.ok) throw new Error(c.error);
    expect(c.retirements).toMatchObject([{ specId: a.id, state: 'superseded' }]);
    expect((await row(a.id)).status).toBe('superseded');
  });

  test('a link asked for with retire [] shows A unchecked and approves only', async () => {
    const a = await approved();
    const b = await spec(wsA, { replaces: [a.id] });
    const p = await approveSpecRevision(adminOAuth(), b.spec.id, { revision: 1, expectedVersion: b.spec.version, retire: [] });
    if (!p.ok || !('pending' in p)) throw new Error('expected a pending link');
    const token = new URL(p.pending.confirmUrl).searchParams.get('request')!;
    const view = await approvalRequestView(admin, b.spec.id, token);
    expect(view.state === 'ready' && view.replacing.map((r) => r.checked)).toEqual([false]);
    const c = await confirmSpecApproval(user(admin), b.spec.id, token);
    if (!c.ok) throw new Error(c.error);
    expect(c.retirements).toEqual([]);
    expect([(await row(b.spec.id)).status, (await row(a.id)).status]).toEqual(['approved', 'approved']);
  });

  test('version race over the link: A moved between the link and the confirm; approve stands, retire reports stale', async () => {
    const a = await approved();
    const b = await spec(wsA, { replaces: [a.id] });
    const p = await approveSpecRevision(adminOAuth(), b.spec.id, { revision: 1, expectedVersion: b.spec.version });
    if (!p.ok || !('pending' in p)) throw new Error('expected a pending link');
    const token = new URL(p.pending.confirmUrl).searchParams.get('request')!;
    const aText = await q<{ content: string }>(sql`SELECT content FROM artifacts WHERE id = ${a.bodyArtifactId}::uuid`);
    expect((await reviseSpecDraft(user(member), a.id, { expectedVersion: (await row(a.id)).version, body: `${aText[0].content}R-2: Late.\n` }, { duplicates: false })).ok).toBe(true);
    const c = await confirmSpecApproval(user(admin), b.spec.id, token);
    if (!c.ok) throw new Error(c.error);
    expect((await row(b.spec.id)).status).toBe('approved');
    expect(c.retirements).toMatchObject([{ specId: a.id, state: 'stale' }]);
    expect((await row(a.id)).status).not.toBe('superseded');
  });
});

describe('the pages (R-76, R-100, AC-137)', () => {
  test('A says a replacement is waiting; B says what it replaces; the review sheet lists A, checked by default', async () => {
    const a = await approved();
    const b = await spec(wsA, { replaces: [a.id] });
    const pa = await specPageView(admin, a.id);
    expect(pa.state === 'ok' && pa.replacementWaiting).toEqual([{ id: b.spec.id, title: b.spec.title }]);
    const pb = await specPageView(admin, b.spec.id);
    expect(pb.state === 'ok' && pb.replacesSpecs).toEqual([{ id: a.id, title: a.title }]);
    const review = await specReviewView(user(admin), b.spec.id);
    if (!review.ok) throw new Error(review.error);
    expect(review.review.replacing).toEqual([{ id: a.id, title: a.title, version: (await row(a.id)).version }]);
  });

  test('once B is approved with A retired, A shows nothing waiting and B no longer names a live spec', async () => {
    const a = await approved();
    const b = await spec(wsA, { replaces: [a.id] });
    await approveSpecRevision(user(admin), b.spec.id, { revision: 1, expectedVersion: b.spec.version });
    const pa = await specPageView(admin, a.id);
    expect(pa.state === 'ok' && [pa.retirement?.supersededBy?.id, pa.replacementWaiting]).toEqual([b.spec.id, []]);
    const pb = await specPageView(admin, b.spec.id);
    expect(pb.state === 'ok' && pb.replacesSpecs).toEqual([]);
  });
});
