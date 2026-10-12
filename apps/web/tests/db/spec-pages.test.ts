/**
 * The dashboard spec pages' reads against real Postgres (living-specs.md §9):
 * the list is the workspace's specs as a tree and nothing of another team's;
 * the spec page reads the approved revision by default, any revision on
 * request, the same diff the API returns for two picked revisions, and the
 * review of the waiting revision only for a person who may approve.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

process.env.AUTH_SECRET ||= 'spec-pages-test-secret';

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision } = await import('../../src/lib/specs/approval');
const { diffSpecRevisions } = await import('../../src/lib/specs/diff');
const { specListView, specPageView } = await import('../../src/lib/specs/page-view');

const rand = () => Math.random().toString(36).slice(2, 10);
async function person(teamId: string, role: 'owner' | 'admin' | 'member', name?: string) {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email, name) VALUES (${`u-${rand()}@example.test`}, ${name ?? null}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, ${role})`);
  return u.id;
}

const user = (userId: string) => ({ kind: 'user' as const, userId });
const BODY = '# Checkout\nIntro.\n## Totals\nR-1: Totals are in the shopper currency.\n';
const NEXT = BODY.replace('shopper currency', 'currency the shopper picked');

let teamA: string; let wsA: string; let admin: string; let member: string; let outsider: string;
let parentId: string; let childId: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${wsA}::uuid`);
  admin = await person(teamA, 'admin', 'Ada Admin');
  member = await person(teamA, 'member');
  const { teamId: teamB } = await seedWorkspace();
  outsider = await person(teamB, 'owner');

  // A parent approved at 1 with revision 2 waiting, and a never-approved child.
  const p = await createSpecDraft(user(member), { workspaceId: wsA, title: `Checkout ${rand()}`, body: BODY });
  if (!p.ok) throw new Error(p.error);
  parentId = p.spec.id;
  const a = await approveSpecRevision(user(admin), parentId, { revision: 1, expectedVersion: 1 });
  if (!a.ok) throw new Error(a.error);
  const r = await reviseSpecDraft(user(member), parentId, { expectedVersion: a.spec.version, body: NEXT, changeSummary: 'Pick the currency' });
  if (!r.ok) throw new Error(r.error);
  const c = await createSpecDraft(user(member), { workspaceId: wsA, title: `Totals ${rand()}`, body: '# Totals\nR-2: Round half up.\n', parentSpecId: parentId });
  if (!c.ok) throw new Error(c.error);
  childId = c.spec.id;
});

describe('spec list', () => {
  test('is the workspace specs as a tree, saying where each stands', async () => {
    const v = await specListView(member, wsA);
    if (v.state !== 'ok') throw new Error('expected ok');
    const parent = v.specs.find((s) => s.id === parentId)!;
    expect(parent).toMatchObject({ standing: 'approved at revision 1', waiting: 2 });
    expect(parent.children.map((c) => c.id)).toEqual([childId]);
    expect(parent.children[0]).toMatchObject({ standing: 'draft, never approved', waiting: null });
    expect(v.specs.some((s) => s.id === childId)).toBe(false);
  });

  test('another team reads nothing (AC-23)', async () => {
    expect(await specListView(outsider, wsA)).toEqual({ state: 'not_found' });
    expect(await specPageView(outsider, parentId)).toEqual({ state: 'not_found' });
  });
});

describe('spec page', () => {
  test('reads the approved revision by default and says the newer one waits (AC-24)', async () => {
    const v = await specPageView(member, parentId);
    if (v.state !== 'ok') throw new Error('expected ok');
    expect(v.reading).toEqual({ revision: 1, approved: true, isHead: false });
    expect(v.body).toBe(BODY);
    expect(v.waiting).toBe(2);
    expect(v.children.map((c) => c.id)).toEqual([childId]);
    expect(v.revisions.map((r) => [r.revision, r.author, r.changeSummary, r.approvedBy])).toEqual([
      [2, 'person', 'Pick the currency', null],
      [1, 'person', null, 'Ada Admin'],
    ]);
    const two = await specPageView(member, parentId, { revision: 2 });
    if (two.state !== 'ok') throw new Error('expected ok');
    expect(two.reading).toEqual({ revision: 2, approved: false, isHead: true });
    expect(two.body).toBe(NEXT);
  });

  test('a child names its parent; a never-approved spec reads its head', async () => {
    const v = await specPageView(member, childId);
    if (v.state !== 'ok') throw new Error('expected ok');
    expect(v.parent?.id).toBe(parentId);
    expect(v.reading).toEqual({ revision: 1, approved: false, isHead: true });
  });

  test('two picked revisions show the rows diffSpecRevisions returns (AC-25)', async () => {
    const v = await specPageView(member, parentId, { from: 1, to: 2 });
    if (v.state !== 'ok' || !v.compare || 'error' in v.compare) throw new Error('expected a compare');
    const d = await diffSpecRevisions(user(member), parentId, { from: 1, to: 2, rows: true });
    if (!d.ok) throw new Error(d.error);
    expect(v.compare.hunks).toEqual(d.diff.hunks!);
    expect(v.compare).toMatchObject({ from: 1, to: 2, linesAdded: 1, linesRemoved: 1 });
  });

  test('only an approver gets the review, and approving it is the approve route (AC-27)', async () => {
    const asMember = await specPageView(member, parentId, { review: true });
    if (asMember.state !== 'ok') throw new Error('expected ok');
    expect(asMember.canApprove).toBe(false);
    expect(asMember.review).toBeNull();

    const asAdmin = await specPageView(admin, parentId, { review: true });
    if (asAdmin.state !== 'ok' || !asAdmin.review) throw new Error('expected a review');
    expect(asAdmin.canApprove).toBe(true);
    expect(asAdmin.review).toMatchObject({ revision: 2, replaces: 1, body: NEXT });
    const r = await approveSpecRevision(user(admin), parentId, { revision: asAdmin.review.revision, expectedVersion: asAdmin.spec.version });
    if (!r.ok || 'pending' in r) throw new Error('expected an approval');
    const after = await specPageView(admin, parentId, { review: true });
    if (after.state !== 'ok') throw new Error('expected ok');
    expect(after).toMatchObject({ reading: { revision: 2, approved: true }, waiting: null, canApprove: false, review: null });
  });
});
