/**
 * Comments on a spec revision (Living Specs R-26, living-specs.md §16) against
 * real Postgres: a comment belongs to the revision it was made on; a later
 * revision shows it open when its anchor is unchanged and outdated when the
 * anchor changed; a comment made later is not shown on an earlier revision;
 * resolving is a person's act; and nothing here changes the spec.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision } = await import('../../src/lib/specs/approval');
const { addSpecComment, listSpecComments, resolveSpecComment } = await import('../../src/lib/specs/comments');

const rand = () => Math.random().toString(36).slice(2, 10);
const ACCOUNT = '00000000-0000-4000-8000-0000000000c7';
let teamId: string; let ws: string; let admin: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId, workspaceId: ws } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${ws}::uuid`);
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, 'admin')`);
  admin = u.id;
});
const user = () => ({ kind: 'user' as const, userId: admin });
const agent = () => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId, workspaceIds: null, taskScope: { taskId: '00000000-0000-4000-8000-0000000000c8', workspaceId: ws } } as any });

const body = (ac1: string, ac2: string, intro = 'Totals and states.') => `# Cart\n\n## Scope\n${intro}\n\n## Criteria\n- **AC-1** ${ac1}\n- **AC-2** ${ac2}\n`;

describe('comments on a revision', () => {
  test('open on unchanged text, outdated on changed text, hidden on earlier revisions; the spec never moves', async () => {
    const d = await createSpecDraft(user(), { workspaceId: ws, title: `Cart ${rand()}`, body: body('Empty cart shows the empty state.', 'Totals in the shopper currency.') }, { duplicates: false });
    if (!d.ok) throw new Error(d.error);
    const a = await approveSpecRevision(user(), d.spec.id, { revision: 1, expectedVersion: 1 });
    if (!a.ok) throw new Error(a.error);
    const before = (await q<{ version: number; approved: number; hash: string }>(sql`SELECT s.version, s.approved_revision AS approved, r.content_hash AS hash FROM specs s JOIN spec_revisions r ON r.spec_id = s.id AND r.revision = 1 WHERE s.id = ${d.spec.id}::uuid`))[0]!;

    const onAc2 = await addSpecComment(agent(), d.spec.id, { anchor: { criterion: 'AC-2' }, body: 'Which currency when the shopper has none?' });
    if (!onAc2.ok) throw new Error(onAc2.error);
    const onScope = await addSpecComment(user(), d.spec.id, { anchor: { heading: 'Scope' }, body: 'Say what is out of scope.' });
    if (!onScope.ok) throw new Error(onScope.error);
    expect(onAc2.comment).toMatchObject({ anchor: { kind: 'criterion', id: 'AC-2' }, author: { kind: 'agent' }, madeOnRevision: 1, state: 'open' });

    const after = (await q<{ version: number; approved: number; hash: string }>(sql`SELECT s.version, s.approved_revision AS approved, r.content_hash AS hash FROM specs s JOIN spec_revisions r ON r.spec_id = s.id AND r.revision = 1 WHERE s.id = ${d.spec.id}::uuid`))[0]!;
    expect(after).toEqual(before);

    // Revision 2 changes AC-1 only: both comments are still open.
    const r2 = await reviseSpecDraft(user(), d.spec.id, { expectedVersion: after.version, body: body('An empty cart says so.', 'Totals in the shopper currency.') });
    if (!r2.ok) throw new Error(r2.error);
    const on2 = await listSpecComments(user(), d.spec.id, { revision: 2 });
    if (!on2.ok) throw new Error(on2.error);
    expect(on2.comments.map((c) => [c.anchor.id === 'AC-2' ? 'AC-2' : 'Scope', c.state])).toEqual([['AC-2', 'open'], ['Scope', 'open']]);

    // Revision 3 changes AC-2 and the scope section: both outdated there, still open on revision 1.
    const r3 = await reviseSpecDraft(user(), d.spec.id, { expectedVersion: r2.spec.version, body: body('An empty cart says so.', 'Totals in the store currency.', 'Totals, states and taxes.') });
    if (!r3.ok) throw new Error(r3.error);
    const on3 = await listSpecComments(user(), d.spec.id, { revision: 3 });
    expect(on3.ok && on3.comments.map((c) => c.state)).toEqual(['outdated', 'outdated']);
    const on1 = await listSpecComments(user(), d.spec.id, { revision: 1 });
    expect(on1.ok && on1.comments.map((c) => c.state)).toEqual(['open', 'open']);

    // A comment made on revision 3 is not shown on revision 1.
    const later = await addSpecComment(user(), d.spec.id, { anchor: { criterion: 'AC-2' }, body: 'Store currency is right.', replyTo: onAc2.comment.id });
    if (!later.ok) throw new Error(later.error);
    expect(later.comment).toMatchObject({ madeOnRevision: 3, parentCommentId: onAc2.comment.id });
    const on1b = await listSpecComments(user(), d.spec.id, { revision: 1 });
    expect(on1b.ok && on1b.comments.map((c) => c.id)).not.toContain(later.comment.id);
  });

  test('an anchor that is not in the revision is refused; resolving is a person\'s act and idempotent', async () => {
    const d = await createSpecDraft(user(), { workspaceId: ws, title: `Cart ${rand()}`, body: body('a', 'b') }, { duplicates: false });
    if (!d.ok) throw new Error(d.error);
    expect(await addSpecComment(user(), d.spec.id, { anchor: { criterion: 'AC-9' }, body: 'x' })).toMatchObject({ ok: false, status: 400 });
    expect(await addSpecComment(user(), d.spec.id, { anchor: { heading: 'Nope' }, body: 'x' })).toMatchObject({ ok: false, status: 400 });
    expect(await addSpecComment(user(), d.spec.id, { anchor: { criterion: 'AC-1' }, body: '' })).toMatchObject({ ok: false, status: 400 });
    const c = await addSpecComment(agent(), d.spec.id, { anchor: { criterion: 'AC-1' }, body: 'Is a an acceptance criterion?' });
    if (!c.ok) throw new Error(c.error);
    expect(await resolveSpecComment(agent(), d.spec.id, c.comment.id)).toMatchObject({ ok: false, status: 403 });
    const r = await resolveSpecComment(user(), d.spec.id, c.comment.id);
    expect(r.ok).toBe(true);
    const again = await resolveSpecComment(user(), d.spec.id, c.comment.id);
    expect(again.ok && r.ok && again.resolvedAt).toBe(r.ok ? r.resolvedAt : '');
    const list = await listSpecComments(user(), d.spec.id);
    expect(list.ok && list.comments[0]!.state).toBe('resolved');
  });
});
