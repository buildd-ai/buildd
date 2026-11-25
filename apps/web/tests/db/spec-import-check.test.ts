/**
 * Import auto-confirm and the batch retirement proposal (Living Spec 65ed7fa3
 * R-370 to R-372, AC-370 to AC-372), against real Postgres.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

process.env.AUTH_SECRET ||= 'spec-import-check-test-secret';

const { createSpecDraft } = await import('../../src/lib/specs/store');
const { applyImportCheck, proposeRetirementBatch, answerOwnerQuestion, openOwnerQuestions } = await import('../../src/lib/specs/import-check-store');
const { specApprovalDeps } = await import('../../src/lib/specs/approval');

const rand = () => Math.random().toString(36).slice(2, 10);
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
async function person(teamId: string, role: 'owner' | 'admin' | 'member') {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, ${role})`);
  return u.id;
}
const user = (userId: string) => ({ kind: 'user' as const, userId });

let teamId: string; let wsId: string; let owner: string; let member: string;
beforeAll(async () => {
  assertDbConfigured();
  specApprovalDeps.afterResponse = () => {};
  ({ teamId, workspaceId: wsId } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${wsId}::uuid`);
  owner = await person(teamId, 'owner');
  member = await person(teamId, 'member');
});

const agent = () => ({ kind: 'account' as const, account: { id: '00000000-0000-4000-8000-0000000000a1', teamId, workspaceIds: null } as any });

async function imported(checks: string[]) {
  const blobSha = hex(40);
  const body = `# Widgets\n${checks.map((c, i) => `- R-${i + 1}: Widgets hold ${rand()}.\n  check: ${c}\n`).join('')}${checks.length ? '' : `- R-1: Widgets hold ${rand()}.\n`}`;
  const r = await createSpecDraft(user(member), { workspaceId: wsId, title: `Widgets ${rand()}`, body }, {
    duplicates: false, imported: { path: `docs/specs/${rand()}.md`, commitSha: hex(40), blobSha, prNumber: null, importedAt: new Date().toISOString() },
  });
  if (!r.ok) throw new Error(r.error);
  return { id: r.spec.id, blobSha };
}
const status = async (id: string) => (await q<{ status: string; approved_by: string | null; via: string | null }>(sql`
  SELECT s.status, r.approved_by, r.approval->>'via' AS via FROM specs s JOIN spec_revisions r ON r.spec_id = s.id AND r.revision = s.head_revision WHERE s.id = ${id}::uuid`))[0]!;

describe('import check (R-370, AC-370)', () => {
  test('every check passing confirms, recorded as import-check with the head', async () => {
    const s = await imported(['bun test a', 'bun test b']);
    const head = hex(40);
    const r = await applyImportCheck(s.id, { headSha: head, fileBlobSha: s.blobSha, results: [{ criterionId: 'R-1', outcome: 'pass' }, { criterionId: 'R-2', outcome: 'pass' }] });
    expect(r.state).toBe('confirmed');
    const row = await status(s.id);
    expect(row).toMatchObject({ status: 'approved', approved_by: 'check:import-check', via: 'import-check' });
    const [rec] = await q<{ head: string }>(sql`SELECT approval->'importCheck'->>'headSha' AS head FROM spec_revisions WHERE spec_id = ${s.id}::uuid AND revision = 1`);
    expect(rec!.head).toBe(head);
  });
  test('a spec with no check, or a file that moved, stays unconfirmed', async () => {
    const none = await imported([]);
    expect((await applyImportCheck(none.id, { headSha: hex(40), fileBlobSha: none.blobSha, results: [] })).state).toBe('none');
    const moved = await imported(['bun test a']);
    expect((await applyImportCheck(moved.id, { headSha: hex(40), fileBlobSha: hex(40), results: [{ criterionId: 'R-1', outcome: 'pass' }] })).state).toBe('none');
    expect((await status(moved.id)).status).not.toBe('approved');
  });
});

describe('one question per spec (R-371, AC-371)', () => {
  test('three failing checks, run twice, leave one open question', async () => {
    const s = await imported(['a', 'b', 'c']);
    const results = ['R-1', 'R-2', 'R-3'].map((criterionId) => ({ criterionId, outcome: 'fail' as const }));
    const a = await applyImportCheck(s.id, { headSha: hex(40), fileBlobSha: s.blobSha, results });
    const b = await applyImportCheck(s.id, { headSha: hex(40), fileBlobSha: s.blobSha, results });
    expect(a.state).toBe('question');
    expect(b.state).toBe('question');
    const open = await openOwnerQuestions(user(owner), wsId);
    if (!open.ok) throw new Error(open.error);
    expect(open.questions.filter((x) => x.specId === s.id)).toHaveLength(1);
    expect((await status(s.id)).status).not.toBe('approved');
  });
});

describe('batch retirement (R-372, AC-372)', () => {
  test('an agent proposes, cannot answer; one yes retires the kept specs', async () => {
    const specsToRetire = [await imported([]), await imported([]), await imported([]), await imported([])];
    const items = specsToRetire.map((s) => ({ specId: s.id, reason: 'Stale: the feature was removed long ago' }));
    const p = await proposeRetirementBatch(agent(), { workspaceId: wsId, items });
    if (!p.ok) throw new Error(p.error);
    const refused = await answerOwnerQuestion(agent(), p.questionId, {});
    expect(refused.ok).toBe(false);
    const memberTry = await answerOwnerQuestion(user(member), p.questionId, {});
    expect(memberTry.ok).toBe(false);
    const keep = specsToRetire.slice(0, 3).map((s) => s.id);
    const done = await answerOwnerQuestion(user(owner), p.questionId, { keep });
    if (!done.ok) throw new Error(done.error);
    expect(done.retired.map((r) => r.specId).sort()).toEqual([...keep].sort());
    expect((await status(specsToRetire[3]!.id)).status).not.toBe('retired');
    expect((await status(keep[0]!)).status).toBe('retired');
  });
});
