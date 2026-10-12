/**
 * Section revise (apps/web/src/lib/specs/section-revise.ts), against real
 * Postgres: an agent sends one section's new text and the version it read;
 * the server writes a new whole revision with only that span replaced, through
 * the same version-checked revise as a full-body write.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { createSpecDraft, reviseSpecDraft, getSpec, MAX_SPEC_BODY_CHARS } = await import('../../src/lib/specs/store');
const { reviseSpecSection } = await import('../../src/lib/specs/section-revise');
const { submitSpecRevision, approveSpecRevision } = await import('../../src/lib/specs/approval');

const rand = () => Math.random().toString(36).slice(2, 10);
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
async function person(teamId: string, role: 'owner' | 'admin' | 'member') {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, ${role})`);
  return u.id;
}

let teamA: string; let wsA: string; let member: string; let admin: string; let outsider: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${wsA}::uuid`);
  member = await person(teamA, 'member');
  admin = await person(teamA, 'admin');
  const { teamId: teamB } = await seedWorkspace();
  outsider = await person(teamB, 'member');
});
const user = (userId: string) => ({ kind: 'user' as const, userId });
const agent = () => ({ kind: 'account' as const, account: { id: '00000000-0000-4000-8000-0000000000a1', teamId: teamA, workspaceIds: null, taskScope: { taskId: '00000000-0000-4000-8000-0000000000f1', workspaceId: wsA } } as any });

const INTRO = '# Checkout\nThe checkout contract.\n\n';
const CURRENCY = '## Currency\nR-1: Totals are in the shopper\'s currency.\n\n';
const CACHING = '## Caching\nR-2: Rates are cached for 15 minutes.\n\n';
const CACHE_SUB = '### Expiry\nAC-2 Stale rates are refetched.\n\n';
const REFUNDS = '## Refunds\nR-3: Refunds go to the original card.\n';
const BODY = INTRO + CURRENCY + CACHING + CACHE_SUB + REFUNDS;
// Outline ids: s1 Checkout, s2 Currency, s3 Caching (with s4 Expiry inside it), s5 Refunds.

async function draft(body = BODY) {
  const r = await createSpecDraft(user(member), { workspaceId: wsA, title: `Checkout ${rand()}`, body });
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}
const headBody = async (specId: string) => {
  const g = await getSpec(user(member), specId);
  if (!g.ok) throw new Error(g.error);
  return g.view;
};

describe('a section revise replaces exactly one section', () => {
  test('by id: the new revision is the old body with only that span replaced, hash-pinned', async () => {
    const spec = await draft();
    const next = '## Caching\nR-2: Rates are cached for 5 minutes.\n\n';
    const r = await reviseSpecSection(agent(), spec.id, { expectedVersion: 1, section: 's3', body: next, changeSummary: 'shorter cache' });
    if (!r.ok) throw new Error(r.error);
    const expected = INTRO + CURRENCY + next + REFUNDS;
    expect([r.spec.version, r.revision.revision, r.revision.contentHash, r.revision.authorKind, r.revision.changeSummary]).toEqual([2, 2, sha(expected), 'agent', 'shorter cache']);
    const view = await headBody(spec.id);
    expect(view.body).toBe(expected);
    const v1 = await getSpec(user(member), spec.id, { revision: 1 });
    expect(v1.ok && v1.view.body).toBe(BODY);
  });

  test('by heading text: a unique heading names the section', async () => {
    const spec = await draft();
    const next = '## Refunds\nR-3: Refunds go to the original payment method.\n';
    const r = await reviseSpecSection(agent(), spec.id, { expectedVersion: 1, heading: 'Refunds', body: next });
    expect(r.ok && r.revision.revision).toBe(2);
    expect((await headBody(spec.id)).body).toBe(INTRO + CURRENCY + CACHING + CACHE_SUB + next);
  });

  test('a replacement without a trailing newline does not run into the next heading', async () => {
    const spec = await draft();
    const r = await reviseSpecSection(agent(), spec.id, { expectedVersion: 1, section: 's2', body: '## Currency\nR-1: Totals are in euros.' });
    expect(r.ok).toBe(true);
    expect((await headBody(spec.id)).body).toBe(INTRO + '## Currency\nR-1: Totals are in euros.\n' + CACHING + CACHE_SUB + REFUNDS);
  });

  test('the same text again writes no new revision', async () => {
    const spec = await draft();
    const r = await reviseSpecSection(agent(), spec.id, { expectedVersion: 1, section: 's2', body: CURRENCY });
    expect(r.ok && [r.unchanged, r.spec.version]).toEqual([true, 1]);
  });
});

describe('a section revise that cannot apply writes nothing', () => {
  const count = async (specId: string) => (await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM spec_revisions WHERE spec_id = ${specId}::uuid`))[0].n;

  test('a stale version: 409 with the current version', async () => {
    const spec = await draft();
    await reviseSpecDraft(user(member), spec.id, { expectedVersion: 1, body: BODY + '\nmore\n' });
    expect(await reviseSpecSection(agent(), spec.id, { expectedVersion: 1, section: 's2', body: CURRENCY + 'x\n' })).toMatchObject({ ok: false, status: 409, currentVersion: 2 });
    expect(await count(spec.id)).toBe(2);
  });

  test('two section writers from one version: exactly one lands', async () => {
    const spec = await draft();
    const [a, b] = await Promise.all([
      reviseSpecSection(agent(), spec.id, { expectedVersion: 1, section: 's2', body: '## Currency\nR-1: a\n\n' }),
      reviseSpecSection(user(member), spec.id, { expectedVersion: 1, section: 's5', body: '## Refunds\nR-3: b\n' }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect((a.ok ? b : a)).toMatchObject({ ok: false, status: 409, currentVersion: 2 });
    expect(await count(spec.id)).toBe(2);
  });

  test('an unknown section id: 400', async () => {
    const spec = await draft();
    const r = await reviseSpecSection(agent(), spec.id, { expectedVersion: 1, section: 's99', body: '## X\n' });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(!r.ok && r.error).toContain('outline');
    expect(await count(spec.id)).toBe(1);
  });

  test('an ambiguous or unknown heading: 400', async () => {
    const spec = await draft(BODY + '\n## Caching\nAgain.\n');
    expect(await reviseSpecSection(agent(), spec.id, { expectedVersion: 1, heading: 'Caching', body: '## Caching\n' })).toMatchObject({ ok: false, status: 400 });
    expect(await reviseSpecSection(agent(), spec.id, { expectedVersion: 1, heading: 'Nope', body: '## Nope\n' })).toMatchObject({ ok: false, status: 400 });
    expect(await count(spec.id)).toBe(1);
  });

  test('both or neither of section and heading: 400', async () => {
    const spec = await draft();
    expect(await reviseSpecSection(agent(), spec.id, { expectedVersion: 1, section: 's2', heading: 'Currency', body: CURRENCY })).toMatchObject({ ok: false, status: 400 });
    expect(await reviseSpecSection(agent(), spec.id, { expectedVersion: 1, body: CURRENCY })).toMatchObject({ ok: false, status: 400 });
    expect(await count(spec.id)).toBe(1);
  });

  test('a result over the body cap: 400', async () => {
    const spec = await draft();
    const r = await reviseSpecSection(agent(), spec.id, { expectedVersion: 1, section: 's2', body: '## Currency\n' + 'x'.repeat(MAX_SPEC_BODY_CHARS) });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(await count(spec.id)).toBe(1);
  });

  test('another team: 404', async () => {
    const spec = await draft();
    expect(await reviseSpecSection(user(outsider), spec.id, { expectedVersion: 1, section: 's2', body: CURRENCY + 'x\n' })).toMatchObject({ ok: false, status: 404 });
    expect(await count(spec.id)).toBe(1);
  });
});

describe('approval is untouched', () => {
  test('on an approved spec a section revise proposes N+1 and N stays in force', async () => {
    const spec = await draft();
    const sub = await submitSpecRevision(user(admin), spec.id, { expectedVersion: 1 });
    if (!sub.ok) throw new Error(sub.error);
    const ap = await approveSpecRevision(user(admin), spec.id, { revision: 1, expectedVersion: sub.spec.version });
    if (!ap.ok) throw new Error(ap.error);
    const r = await reviseSpecSection(agent(), spec.id, { expectedVersion: ap.spec.version, section: 's5', body: '## Refunds\nR-3: changed\n' });
    if (!r.ok) throw new Error(r.error);
    expect([r.spec.status, r.spec.approvedRevision, r.spec.headRevision, r.revision.approvedBy]).toEqual(['draft', 1, 2, null]);
  });
});
