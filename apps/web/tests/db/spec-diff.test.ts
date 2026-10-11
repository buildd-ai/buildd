/**
 * What changed between two Living Spec revisions (apps/web/src/lib/specs/diff.ts),
 * against real Postgres: both bodies read hash-checked from the artifact
 * revision each spec revision pins, the approved revision as the default
 * base, workspace scoping as for get, and each read in the read ledger.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision } = await import('../../src/lib/specs/approval');
const { diffSpecRevisions } = await import('../../src/lib/specs/diff');

const rand = () => Math.random().toString(36).slice(2, 10);
async function person(teamId: string, role: 'admin' | 'member') {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, ${role})`);
  return u.id;
}

let teamA: string; let wsA: string; let admin: string; let outsider: string; let TASK: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${wsA}::uuid`);
  const { teamId: teamB } = await seedWorkspace();
  admin = await person(teamA, 'admin');
  outsider = await person(teamB, 'member');
  TASK = await seedTask(wsA);
});
const user = (userId: string) => ({ kind: 'user' as const, userId });
const agentToken = () => ({ kind: 'account' as const, account: { id: '00000000-0000-4000-8000-0000000000a2', teamId: teamA, workspaceIds: null, taskScope: { taskId: TASK, workspaceId: wsA } } as any });

const R1 = '# Checkout\nIntro.\n## Totals\nR-1: Totals are in the shopper currency.\n## Rates\nR-2: Rates come from the rates service.\n';
const R2 = R1.replace('R-2: Rates come from the rates service.', 'R-2: Rates are cached for 15 minutes.');
const R3 = R2 + '## Refunds\nR-3: Refunds go back to the card.\n';

async function threeRevisions() {
  const c = await createSpecDraft(user(admin), { workspaceId: wsA, title: `Checkout ${rand()}`, body: R1 });
  if (!c.ok) throw new Error(c.error);
  const r2 = await reviseSpecDraft(user(admin), c.spec.id, { expectedVersion: 1, body: R2 });
  if (!r2.ok) throw new Error(r2.error);
  const r3 = await reviseSpecDraft(user(admin), c.spec.id, { expectedVersion: 2, body: R3 });
  if (!r3.ok) throw new Error(r3.error);
  return r3.spec;
}

describe('diff between two revisions', () => {
  test('two named revisions: exactly the changed sections and lines', async () => {
    const spec = await threeRevisions();
    const r = await diffSpecRevisions(user(admin), spec.id, { from: 1, to: 3 });
    if (!r.ok) throw new Error(r.error);
    expect([r.diff.from.revision, r.diff.to.revision, r.diff.identical]).toEqual([1, 3, false]);
    expect(r.diff.sections.map((s) => [s.kind, s.path, s.linesAdded, s.linesRemoved])).toEqual([
      ['changed', 'Checkout > Rates', 1, 1],
      ['added', 'Checkout > Refunds', 2, 0],
    ]);
    expect(r.diff.diff).toContain('-R-2: Rates come from the rates service.');
    expect(r.diff.diff).toContain('+R-2: Rates are cached for 15 minutes.');
    expect(r.diff.diff).toContain('+R-3: Refunds go back to the card.');
    expect(r.diff.diff).not.toContain('R-1');
  });

  test('the same revision on both sides says no change', async () => {
    const spec = await threeRevisions();
    const r = await diffSpecRevisions(user(admin), spec.id, { from: 2, to: 2 });
    expect(r.ok && [r.diff.identical, r.diff.sections, r.diff.diff]).toEqual([true, [], '']);
  });

  test('with no revisions named: the head against the one before it', async () => {
    const spec = await threeRevisions();
    const r = await diffSpecRevisions(user(admin), spec.id);
    expect(r.ok && [r.diff.from.revision, r.diff.to.revision, r.diff.sections.map((s) => s.path)]).toEqual([2, 3, ['Checkout > Refunds']]);
  });

  test('once a revision is approved, the default base is the approved revision, so an approver sees the whole proposal', async () => {
    const c = await createSpecDraft(user(admin), { workspaceId: wsA, title: `Checkout ${rand()}`, body: R1 });
    if (!c.ok) throw new Error(c.error);
    const ok = await approveSpecRevision(user(admin), c.spec.id, { revision: 1, expectedVersion: 1 });
    if (!ok.ok) throw new Error(ok.error);
    const v2 = await reviseSpecDraft(user(admin), c.spec.id, { expectedVersion: ok.spec.version, body: R2 });
    if (!v2.ok) throw new Error(v2.error);
    const v3 = await reviseSpecDraft(user(admin), c.spec.id, { expectedVersion: v2.spec.version, body: R3 });
    if (!v3.ok) throw new Error(v3.error);
    const r = await diffSpecRevisions(user(admin), c.spec.id);
    if (!r.ok) throw new Error(r.error);
    expect([r.diff.from, r.diff.to.revision]).toEqual([{ revision: 1, contentHash: expect.any(String), approved: true }, 3]);
    expect(r.diff.sections.map((s) => s.path)).toEqual(['Checkout > Rates', 'Checkout > Refunds']);
  });

  test('a revision that does not exist is a 404; a first revision alone has nothing to compare', async () => {
    const spec = await threeRevisions();
    expect(await diffSpecRevisions(user(admin), spec.id, { from: 1, to: 9 })).toMatchObject({ ok: false, status: 404 });
    const c = await createSpecDraft(user(admin), { workspaceId: wsA, title: `Solo ${rand()}`, body: R1 });
    if (!c.ok) throw new Error(c.error);
    expect(await diffSpecRevisions(user(admin), c.spec.id)).toMatchObject({ ok: false, status: 400 });
  });

  test('another team cannot diff it, exactly as it cannot read it', async () => {
    const spec = await threeRevisions();
    expect(await diffSpecRevisions(user(outsider), spec.id, { from: 1, to: 2 })).toMatchObject({ ok: false, status: 404 });
    const otherWsToken = { kind: 'account' as const, account: { id: '00000000-0000-4000-8000-0000000000a3', teamId: teamA, workspaceIds: null, taskScope: { taskId: TASK, workspaceId: '00000000-0000-4000-8000-0000000000e9' } } as any };
    expect(await diffSpecRevisions(otherWsToken, spec.id, { from: 1, to: 2 })).toMatchObject({ ok: false, status: 404 });
  });

  test('a body that no longer matches its revision hash is refused, never diffed', async () => {
    const spec = await threeRevisions();
    await q(sql`UPDATE spec_revisions SET content_hash = repeat('0', 64) WHERE spec_id = ${spec.id}::uuid AND revision = 2`);
    expect(await diffSpecRevisions(user(admin), spec.id, { from: 1, to: 2 })).toMatchObject({ ok: false, status: 409 });
  });

  test('both reads are recorded in the read ledger, with the task that asked', async () => {
    const spec = await threeRevisions();
    const r = await diffSpecRevisions(agentToken(), spec.id, { from: 1, to: 3 });
    if (!r.ok) throw new Error(r.error);
    let rows: Array<{ revision: number; task_id: string | null; selector: any; total_chars: number }> = [];
    for (let i = 0; i < 50 && rows.length < 2; i++) {
      await new Promise((res) => setTimeout(res, 20));
      rows = await q(sql`SELECT revision, task_id, selector, total_chars FROM artifact_reads WHERE artifact_id = ${spec.bodyArtifactId}::uuid ORDER BY revision`);
    }
    expect(rows.map((x) => [x.revision, x.task_id, x.selector.diff.specRevision, x.total_chars])).toEqual([[1, TASK, 1, R1.length], [3, TASK, 3, R3.length]]);
  });
});
