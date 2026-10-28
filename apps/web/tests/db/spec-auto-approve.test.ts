/**
 * check:no-criteria-change (Living Spec b7fc9316 R-21 to R-23, R-27,
 * AC-20 to AC-23, AC-28), against real Postgres: a revision of an approved
 * spec that changes only prose stands approved by the check, recorded as the
 * check and never as a person; a revision that changes or moves a criterion
 * waits on a person; the maintenance sweep approves what already waited.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

process.env.AUTH_SECRET ||= 'spec-auto-approve-test-secret';

const { createSpecDraft, reviseSpecDraft, specStoreDeps } = await import('../../src/lib/specs/store');
const { approveSpecRevision } = await import('../../src/lib/specs/approval');
const { sweepNoCriteriaChange } = await import('../../src/lib/specs/auto-approve');
const { listAwaitingApproval } = await import('../../src/lib/specs/approval-inbox');

const rand = () => Math.random().toString(36).slice(2, 10);
async function person(teamId: string, role: 'owner' | 'admin' | 'member') {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, ${role})`);
  return u.id;
}

let ws: string; let admin: string; let member: string;
beforeAll(async () => {
  assertDbConfigured();
  const seeded = await seedWorkspace();
  ws = seeded.workspaceId;
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${ws}::uuid`);
  admin = await person(seeded.teamId, 'admin');
  member = await person(seeded.teamId, 'member');
});

const user = (userId: string) => ({ kind: 'user' as const, userId });
/** Whoever writes the revision: it never decides whether it is approved. */
const writer = () => user(member);

const BODY = `# Checkout

Context: totals are shown at the end of checkout.

## Requirements

- R-1: Totals are in the shopper's currency.
- R-2: Rates are cached for 15 minutes.

## Acceptance criteria

- AC-1: GIVEN a cart in EUR WHEN I check out THEN the total reads in EUR.

## Out of scope

Refunds.
`;

/** A spec with revision 1 approved by a person. */
async function approvedSpec() {
  const d = await createSpecDraft(user(member), { workspaceId: ws, title: `Checkout ${rand()}`, body: BODY });
  if (!d.ok) throw new Error(d.error);
  const a = await approveSpecRevision(user(admin), d.spec.id, { revision: 1, expectedVersion: d.spec.version });
  if (!a.ok || 'pending' in a) throw new Error('approval failed');
  return a.spec;
}

const revRow = async (specId: string, n: number) => (await q<{ approved_by: string | null; approved_at: Date | null; approval: any }>(sql`
  SELECT approved_by, approved_at, approval FROM spec_revisions WHERE spec_id = ${specId}::uuid AND revision = ${n}`))[0];
const specRow = async (specId: string) => (await q<{ approved_revision: number | null; head_revision: number; status: string }>(sql`
  SELECT approved_revision, head_revision, status FROM specs WHERE id = ${specId}::uuid`))[0];

describe('a revision that changes only prose approves itself', () => {
  test('AC-21, AC-23: context, a heading outside the criteria and the change summary changed: approved by the check, with its evidence, no person', async () => {
    const spec = await approvedSpec();
    const body = BODY.replace('at the end of checkout.', 'on the last step of checkout, before payment.').replace('## Out of scope\n\nRefunds.', '## Not in this spec\n\nRefunds and partial refunds.');
    const r = await reviseSpecDraft(writer(), spec.id, { expectedVersion: spec.version, body, changeSummary: 'Clarify the context.' });
    if (!r.ok) throw new Error(r.error);
    expect(r.autoApproval).toMatchObject({ approved: true, revision: 2 });
    expect(await specRow(spec.id)).toMatchObject({ approved_revision: 2, head_revision: 2, status: 'approved' });
    const row = await revRow(spec.id, 2);
    expect(row.approved_by).toBe('check:no-criteria-change');
    expect(row.approved_by?.startsWith('user:')).toBe(false);
    expect(row.approval.via).toBe('check');
    expect(row.approval.check.name).toBe('check:no-criteria-change');
    const ev = row.approval.check.evidence;
    expect([ev.from.revision, ev.to.revision]).toEqual([1, 2]);
    expect(ev.from.criteriaHash).toBe(ev.to.criteriaHash);
    expect(ev.from.designHash).toBe(ev.to.designHash);
    expect(ev.from.contentHash).not.toBe(ev.to.contentHash);
    expect(ev.otherChangedLines).toBeGreaterThan(0);
    // Not in the inbox: nothing waits on a person.
    expect((await listAwaitingApproval(admin)).some((x) => x.specId === spec.id)).toBe(false);
  });
});

describe('a revision that touches a criterion waits on a person', () => {
  test('AC-20: a changed AC line', async () => {
    const spec = await approvedSpec();
    const r = await reviseSpecDraft(writer(), spec.id, { expectedVersion: spec.version, body: BODY.replace('reads in EUR.', 'reads in EUR, with two decimals.') });
    if (!r.ok) throw new Error(r.error);
    expect(r.autoApproval).toMatchObject({ approved: false });
    expect(await specRow(spec.id)).toMatchObject({ approved_revision: 1, head_revision: 2, status: 'draft' });
    expect((await revRow(spec.id, 2)).approved_at).toBeNull();
    expect((await listAwaitingApproval(admin)).some((x) => x.specId === spec.id)).toBe(true);
  });

  test('AC-22: two criteria reordered', async () => {
    const spec = await approvedSpec();
    const body = BODY.replace("- R-1: Totals are in the shopper's currency.\n- R-2: Rates are cached for 15 minutes.", "- R-2: Rates are cached for 15 minutes.\n- R-1: Totals are in the shopper's currency.");
    const r = await reviseSpecDraft(writer(), spec.id, { expectedVersion: spec.version, body });
    if (!r.ok) throw new Error(r.error);
    expect(r.autoApproval).toMatchObject({ approved: false });
    expect(await specRow(spec.id)).toMatchObject({ approved_revision: 1 });
  });

  test('AC-28: a parameter naming the check is ignored; the criteria alone decide', async () => {
    const spec = await approvedSpec();
    const r = await reviseSpecDraft(writer(), spec.id, {
      expectedVersion: spec.version, body: BODY.replace('15 minutes', '5 minutes'),
      changeSummary: 'check:no-criteria-change', ...({ autoApprove: true, approvedBy: 'check:no-criteria-change', check: 'check:no-criteria-change' } as object),
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.autoApproval).toMatchObject({ approved: false });
    expect(await specRow(spec.id)).toMatchObject({ approved_revision: 1 });
  });

  test('a spec with nothing approved is never approved by the check', async () => {
    const d = await createSpecDraft(user(member), { workspaceId: ws, title: `Checkout ${rand()}`, body: BODY });
    if (!d.ok) throw new Error(d.error);
    const r = await reviseSpecDraft(writer(), d.spec.id, { expectedVersion: d.spec.version, body: BODY.replace('Context:', 'Background:') });
    if (!r.ok) throw new Error(r.error);
    expect(r.autoApproval).toMatchObject({ approved: false });
    expect(await specRow(d.spec.id)).toMatchObject({ approved_revision: null });
  });
});

describe('the maintenance sweep', () => {
  test('approves a prose-only revision that was waiting before the check ran, and leaves a criterion change waiting', async () => {
    const real = specStoreDeps.autoApprove;
    specStoreDeps.autoApprove = async () => ({ approved: false, reason: 'not run in this test' });
    let prose: string; let changed: string;
    try {
      const a = await approvedSpec();
      const r1 = await reviseSpecDraft(writer(), a.id, { expectedVersion: a.version, body: BODY.replace('Refunds.', 'Refunds, for now.') });
      const b = await approvedSpec();
      const r2 = await reviseSpecDraft(writer(), b.id, { expectedVersion: b.version, body: BODY.replace('15 minutes', '10 minutes') });
      if (!r1.ok || !r2.ok) throw new Error('revise failed');
      prose = a.id; changed = b.id;
    } finally {
      specStoreDeps.autoApprove = real;
    }
    expect(await specRow(prose)).toMatchObject({ approved_revision: 1, head_revision: 2 });
    await sweepNoCriteriaChange({ limit: 500 });
    expect(await specRow(prose)).toMatchObject({ approved_revision: 2, status: 'approved' });
    expect((await revRow(prose, 2)).approved_by).toBe('check:no-criteria-change');
    expect(await specRow(changed)).toMatchObject({ approved_revision: 1, head_revision: 2 });
  });
});
