/**
 * Living Specs: a task is pinned to the revision in force when its work
 * starts (task 5c0a3f4c). Filing pins the approved revision (G2); the first
 * claim re-pins to whatever is approved then, and once any worker has run the
 * pin never moves again: a retry attempt or a resumed claim keeps it.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision } = await import('../../src/lib/specs/approval');
const { pinSpecSource, readPinnedSpecRevision } = await import('../../src/lib/specs/pin');
const { repinSpecAtClaim } = await import('../../src/lib/specs/claim-pin');

const rand = () => Math.random().toString(36).slice(2, 10);
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const BODY_N = '# Checkout\nR-1: Totals are in the shopper\'s currency.\n';
const BODY_N1 = BODY_N + 'R-2: Rates are cached for 15 minutes.\n';

let teamId: string; let wsA: string; let admin: string; let member: string;
const user = (userId: string) => ({ kind: 'user' as const, userId });

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId, workspaceId: wsA } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${wsA}::uuid`);
  for (const role of ['admin', 'member'] as const) {
    const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
    await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, ${role})`);
    if (role === 'admin') admin = u.id; else member = u.id;
  }
});

/** A spec with N approved, plus a function that proposes and approves N+1. */
async function approvedSpec() {
  const d = await createSpecDraft(user(member), { workspaceId: wsA, title: `Checkout ${rand()}`, body: BODY_N });
  if (!d.ok) throw new Error(d.error);
  const a = await approveSpecRevision(user(admin), d.spec.id, { revision: 1, expectedVersion: 1 });
  if (!a.ok) throw new Error(a.error);
  const approveN1 = async () => {
    const r = await reviseSpecDraft(user(member), d.spec.id, { expectedVersion: a.spec.version, body: BODY_N1 });
    if (!r.ok) throw new Error(r.error);
    const a2 = await approveSpecRevision(user(admin), d.spec.id, { revision: 2, expectedVersion: r.spec.version });
    if (!a2.ok) throw new Error(a2.error);
    return a2.revision.id;
  };
  return { specId: d.spec.id, revN: a.revision.id, approveN1 };
}

async function fileTask(context: Record<string, unknown>, taskClass: 'work' | 'attempt' = 'work') {
  const pinned = await pinSpecSource(wsA, context);
  if (!pinned.ok) throw new Error(pinned.error);
  const [t] = await q<{ id: string }>(sql`
    INSERT INTO tasks (workspace_id, title, status, context, task_class)
    VALUES (${wsA}::uuid, ${`task-${rand()}`}, 'pending', ${JSON.stringify(pinned.context)}::jsonb, ${taskClass})
    RETURNING id`);
  return { id: t.id, context: pinned.context as Record<string, unknown>, taskClass };
}

async function addWorker(taskId: string) {
  await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status)
    VALUES (${wsA}::uuid, ${taskId}::uuid, ${`w-${rand()}`}, 'test', ${`b-${rand()}`}, 'completed')`);
}

describe('the first claim pins the revision approved at that moment', () => {
  test('filed while N is approved, N+1 approved before the claim: the claim pins N+1, with its hash', async () => {
    const s = await approvedSpec();
    const task = await fileTask({ specSource: { specId: s.specId } });
    expect(task.context.specSource).toMatchObject({ specRevisionId: s.revN, revision: 1 });
    const revN1 = await s.approveN1();

    const r = await repinSpecAtClaim({ ...task, workspaceId: wsA });
    expect(r.specSource).toMatchObject({ specId: s.specId, specRevisionId: revN1, revision: 2, contentHash: sha(BODY_N1), pinnedAt: 'claim', repinnedFrom: 1 });
    // The reviewer's hash-checked read resolves the new pin.
    expect(await readPinnedSpecRevision(r.specSource)).toMatchObject({ ok: true, revision: 2, body: BODY_N1 });
  });

  test('when the approved revision is still the filed one, nothing changes and nothing needs writing', async () => {
    const s = await approvedSpec();
    const task = await fileTask({ specSource: { specId: s.specId } });
    const r = await repinSpecAtClaim({ ...task, workspaceId: wsA });
    expect(r.specSource).toBeNull();
    expect(r.reason).toMatch(/already pinned/);
  });

  test('a task naming no spec is not read at all', async () => {
    const r = await repinSpecAtClaim({ id: '00000000-0000-4000-8000-000000000001', workspaceId: wsA, context: { other: 1 }, taskClass: 'work' });
    expect(r).toEqual({ specSource: null, reason: null });
  });
});

describe('once work has started the pin never moves', () => {
  test('claimed under N, N+1 approved, the task is claimed again (a resume): still N', async () => {
    const s = await approvedSpec();
    const task = await fileTask({ specSource: { specId: s.specId } });
    await addWorker(task.id);
    await s.approveN1();
    const r = await repinSpecAtClaim({ ...task, workspaceId: wsA });
    expect(r.specSource).toBeNull();
    expect(r.reason).toMatch(/already started/);
  });

  test('a retry attempt carries its parent\'s pin and keeps it, even with no worker of its own', async () => {
    const s = await approvedSpec();
    const attempt = await fileTask({ specSource: { specId: s.specId } }, 'attempt');
    await s.approveN1();
    const r = await repinSpecAtClaim({ ...attempt, workspaceId: wsA });
    expect(r.specSource).toBeNull();
    expect(r.reason).toMatch(/attempt/);
  });

  test('a pin already taken at a claim is final', async () => {
    const s = await approvedSpec();
    const task = await fileTask({ specSource: { specId: s.specId } });
    await s.approveN1();
    const first = await repinSpecAtClaim({ ...task, workspaceId: wsA });
    const r = await repinSpecAtClaim({ ...task, context: { ...task.context, specSource: first.specSource }, workspaceId: wsA });
    expect(r.specSource).toBeNull();
  });

  test('a revision the filer named explicitly is kept', async () => {
    const s = await approvedSpec();
    const task = await fileTask({ specSource: { specId: s.specId, specRevisionId: s.revN } });
    expect(task.context.specSource).toMatchObject({ explicit: true });
    await s.approveN1();
    const r = await repinSpecAtClaim({ ...task, workspaceId: wsA });
    expect(r.specSource).toBeNull();
    expect(r.reason).toMatch(/named/);
  });

  test('a filer cannot claim explicitness or a claim-time pin without naming a revision', async () => {
    const s = await approvedSpec();
    const task = await fileTask({ specSource: { specId: s.specId, explicit: true, pinnedAt: 'claim' } });
    expect(task.context.specSource).not.toHaveProperty('explicit');
    expect(task.context.specSource).not.toHaveProperty('pinnedAt');
  });
});

describe('no approved revision', () => {
  test('a spec without an approved revision leaves the task as filed and says why', async () => {
    const d = await createSpecDraft(user(member), { workspaceId: wsA, title: `Draft ${rand()}`, body: BODY_N });
    if (!d.ok) throw new Error(d.error);
    // A specSource that names the spec but was never pinned (written outside the filing route).
    const r = await repinSpecAtClaim({ id: '00000000-0000-4000-8000-000000000002', workspaceId: wsA, context: { specSource: { specId: d.spec.id } }, taskClass: 'work' });
    expect(r.specSource).toBeNull();
    expect(r.reason).toMatch(/no approved revision/);
  });

  test('a spec in another workspace is never pinned', async () => {
    const s = await approvedSpec();
    const { workspaceId: wsB } = await seedWorkspace();
    const r = await repinSpecAtClaim({ id: '00000000-0000-4000-8000-000000000003', workspaceId: wsB, context: { specSource: { specId: s.specId } }, taskClass: 'work' });
    expect(r.specSource).toBeNull();
    expect(r.reason).toMatch(/not found/);
  });
});

describe('a task scoped to some criteria', () => {
  test('re-pins to N+1 when N+1 still has every criterion it answers for, keeping its scope', async () => {
    const s = await approvedSpec();
    const task = await fileTask({ specSource: { specId: s.specId, criteria: ['R-1'] } });
    const revN1 = await s.approveN1();
    const r = await repinSpecAtClaim({ ...task, workspaceId: wsA });
    expect(r.specSource).toMatchObject({ specRevisionId: revN1, revision: 2, criteria: ['R-1'], pinnedAt: 'claim' });
  });

  test('keeps N when N+1 no longer has a criterion it answers for, and says which', async () => {
    const d = await createSpecDraft(user(member), { workspaceId: wsA, title: `Scoped ${rand()}`, body: BODY_N1 });
    if (!d.ok) throw new Error(d.error);
    const a = await approveSpecRevision(user(admin), d.spec.id, { revision: 1, expectedVersion: 1 });
    if (!a.ok) throw new Error(a.error);
    const task = await fileTask({ specSource: { specId: d.spec.id, criteria: ['R-2'] } });
    const r2 = await reviseSpecDraft(user(member), d.spec.id, { expectedVersion: a.spec.version, body: BODY_N });
    if (!r2.ok) throw new Error(r2.error);
    const a2 = await approveSpecRevision(user(admin), d.spec.id, { revision: 2, expectedVersion: r2.spec.version });
    if (!a2.ok) throw new Error(a2.error);
    const r = await repinSpecAtClaim({ ...task, workspaceId: wsA });
    expect(r.specSource).toBeNull();
    expect(r.reason).toContain('no longer has R-2');
  });
});

