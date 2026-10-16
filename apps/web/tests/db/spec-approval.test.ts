/**
 * Living Specs approval and pinning (G2, decision D-4), against real Postgres:
 * only a person approves, and only an owner/admin of the workspace's team or a
 * delegated approver; an approved revision is never re-stamped; a task filed
 * against a spec is pinned to the approved revision and keeps resolving it
 * after N+1 is proposed; N+1 stays proposed until a person approves it.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

process.env.AUTH_SECRET ||= 'spec-approval-test-secret';

const { createSpecDraft, reviseSpecDraft, getSpec } = await import('../../src/lib/specs/store');
const { submitSpecRevision, approveSpecRevision } = await import('../../src/lib/specs/approval');
const { pinSpecSource, readPinnedSpecRevision } = await import('../../src/lib/specs/pin');

const rand = () => Math.random().toString(36).slice(2, 10);
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
async function person(teamId: string, role: 'owner' | 'admin' | 'member') {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, ${role})`);
  return u.id;
}

let teamA: string; let wsA: string; let wsB: string;
let admin: string; let member: string; let delegate: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${wsA}::uuid`);
  ({ workspaceId: wsB } = await seedWorkspace());
  admin = await person(teamA, 'admin');
  member = await person(teamA, 'member');
  delegate = await person(teamA, 'member');
  await q(sql`UPDATE workspaces SET git_config = coalesce(git_config, '{}'::jsonb) || ${JSON.stringify({ livingSpecs: { approverUserIds: [delegate] } })}::jsonb WHERE id = ${wsA}::uuid`);
});

const user = (userId: string) => ({ kind: 'user' as const, userId });
const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
/** A per-task token: an agent run, never a person. */
const agentToken = () => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId: teamA, workspaceIds: null, taskScope: { taskId: '00000000-0000-4000-8000-0000000000f1', workspaceId: wsA } } as any });
/** A team API key with no person behind it. */
const apiKey = () => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId: teamA, workspaceIds: null } as any });
/** The admin's own OAuth MCP session: a person. */
const adminOAuth = () => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId: teamA, workspaceIds: null, sessionUserId: admin } as any });

const BODY_N = '# Checkout\nR-1: Totals are in the shopper\'s currency.\n';
const BODY_N1 = BODY_N + 'R-2: Rates are cached for 15 minutes.\n';

async function draft() {
  const r = await createSpecDraft(user(member), { workspaceId: wsA, title: `Checkout ${rand()}`, body: BODY_N });
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}

describe('only a person with approval rights approves', () => {
  test('an agent token, a bare API key and a plain member are refused, and nothing is stamped', async () => {
    const spec = await draft();
    for (const caller of [agentToken(), apiKey(), user(member)]) {
      expect(await approveSpecRevision(caller, spec.id, { revision: 1, expectedVersion: 1 })).toMatchObject({ ok: false, status: 403 });
      expect(await submitSpecRevision(caller, spec.id, { expectedVersion: 1 })).toMatchObject({ ok: false, status: 403 });
    }
    const [row] = await q<{ approved_by: string | null; status: string; approved_revision: number | null }>(sql`
      SELECT r.approved_by, s.status, s.approved_revision FROM specs s JOIN spec_revisions r ON r.spec_id = s.id WHERE s.id = ${spec.id}::uuid`);
    expect(row).toEqual({ approved_by: null, status: 'draft', approved_revision: null });
  });

  test('an admin approves; so does a delegated approver', async () => {
    for (const caller of [user(admin), user(delegate)]) {
      const spec = await draft();
      const r = await approveSpecRevision(caller, spec.id, { revision: 1, expectedVersion: 1 });
      expect(r.ok && !('pending' in r) && [r.spec.status, r.spec.approvedRevision, r.revision.approvedBy]).toEqual(['approved', 1, `user:${caller.userId}`]);
    }
  });

  test('the admin\'s own OAuth session asks instead: a confirmation link, nothing approved (spec-approval-confirm.test.ts)', async () => {
    const spec = await draft();
    const r = await approveSpecRevision(adminOAuth(), spec.id, { revision: 1, expectedVersion: 1 });
    expect(r.ok && 'pending' in r && r.pending.revision).toBe(1);
    const [row] = await q<{ approved_revision: number | null }>(sql`SELECT approved_revision FROM specs WHERE id = ${spec.id}::uuid`);
    expect(row.approved_revision).toBeNull();
  });

  test('another team\'s admin cannot see the spec to approve it', async () => {
    const spec = await draft();
    const [{ team_id: teamB }] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${wsB}::uuid`);
    const outsider = await person(teamB, 'admin');
    expect(await approveSpecRevision(user(outsider), spec.id, { revision: 1, expectedVersion: 1 })).toMatchObject({ ok: false, status: 404 });
  });
});

describe('an approval is one decision on one revision', () => {
  test('submit moves the head to in_review; approve stamps it once; a second approve is a 409 and changes nothing', async () => {
    const spec = await draft();
    const s = await submitSpecRevision(user(admin), spec.id, { expectedVersion: 1 });
    expect(s.ok && [s.spec.status, s.spec.version]).toEqual(['in_review', 2]);
    const a = await approveSpecRevision(user(admin), spec.id, { revision: 1, expectedVersion: 2 });
    if (!a.ok) throw new Error(a.error);
    const again = await approveSpecRevision(user(delegate), spec.id, { revision: 1, expectedVersion: a.spec.version });
    expect(again).toMatchObject({ ok: false, status: 409 });
    const [row] = await q<{ approved_by: string }>(sql`SELECT approved_by FROM spec_revisions WHERE spec_id = ${spec.id}::uuid AND revision = 1`);
    expect(row.approved_by).toBe(`user:${admin}`);
  });

  test('approving a revision that is not the head, or from a stale version, is a 409', async () => {
    const spec = await draft();
    const r2 = await reviseSpecDraft(user(member), spec.id, { expectedVersion: 1, body: BODY_N1 });
    if (!r2.ok) throw new Error(r2.error);
    expect(await approveSpecRevision(user(admin), spec.id, { revision: 1, expectedVersion: r2.spec.version })).toMatchObject({ ok: false, status: 409 });
    expect(await approveSpecRevision(user(admin), spec.id, { revision: 2, expectedVersion: 1 })).toMatchObject({ ok: false, status: 409, currentVersion: r2.spec.version });
  });

  test('revising an approved spec proposes N+1 as a draft; N stays the approved revision, byte for byte', async () => {
    const spec = await draft();
    const a = await approveSpecRevision(user(admin), spec.id, { revision: 1, expectedVersion: 1 });
    if (!a.ok) throw new Error(a.error);
    const r2 = await reviseSpecDraft(user(member), spec.id, { expectedVersion: a.spec.version, body: BODY_N1 });
    expect(r2.ok && [r2.spec.status, r2.spec.headRevision, r2.spec.approvedRevision]).toEqual(['draft', 2, 1]);
    const n = await getSpec(user(member), spec.id, { revision: 1 });
    expect(n.ok && [n.view.body, n.view.revision.contentHash]).toEqual([BODY_N, sha(BODY_N)]);
  });
});

describe('running work stays pinned to the revision it started on', () => {
  test('approve N, file a task against the spec, propose N+1: the task and its review still resolve N, and N+1 waits for a person', async () => {
    const spec = await draft();
    const a = await approveSpecRevision(user(admin), spec.id, { revision: 1, expectedVersion: 1 });
    if (!a.ok) throw new Error(a.error);

    const pinned = await pinSpecSource(wsA, { specSource: { specId: spec.id } });
    if (!pinned.ok) throw new Error(pinned.error);
    const src = pinned.context.specSource as Record<string, unknown>;
    expect(src).toMatchObject({ specId: spec.id, specRevisionId: a.revision.id, revision: 1, contentHash: sha(BODY_N) });

    const r2 = await reviseSpecDraft(agentToken(), spec.id, { expectedVersion: a.spec.version, body: BODY_N1 });
    if (!r2.ok) throw new Error(r2.error);

    const read = await readPinnedSpecRevision(src);
    expect(read).toMatchObject({ ok: true, body: BODY_N, revision: 1 });
    const now = await getSpec(user(member), spec.id);
    expect(now.ok && [now.view.spec.approvedRevision, now.view.spec.headRevision, now.view.spec.status]).toEqual([1, 2, 'draft']);

    // N+1 is approved only by a person; the agent that proposed it cannot.
    expect(await approveSpecRevision(agentToken(), spec.id, { revision: 2, expectedVersion: r2.spec.version })).toMatchObject({ ok: false, status: 403 });
    const a2 = await approveSpecRevision(user(admin), spec.id, { revision: 2, expectedVersion: r2.spec.version });
    expect(a2.ok && a2.spec.approvedRevision).toBe(2);
    // The task filed before still resolves N.
    expect(await readPinnedSpecRevision(src)).toMatchObject({ ok: true, body: BODY_N, revision: 1 });
  });

  test('a spec with no approved revision pins its head provisionally (§20, R-36), never as approved', async () => {
    const spec = await draft();
    const p = await pinSpecSource(wsA, { specSource: { specId: spec.id } });
    expect(p.ok && p.context.specSource).toMatchObject({ revision: 1, contentHash: sha(BODY_N), provisional: true });
    expect(p.ok && (p.context.specSource as Record<string, unknown>).explicit).toBeUndefined();
  });

  test('a named revision that is not approved pins provisionally; one the spec does not have is refused', async () => {
    const spec = await draft();
    const [rev1] = await q<{ id: string }>(sql`SELECT id FROM spec_revisions WHERE spec_id = ${spec.id}::uuid AND revision = 1`);
    expect(await pinSpecSource(wsA, { specSource: { specId: spec.id, specRevisionId: rev1.id } })).toMatchObject({ ok: true, context: { specSource: { specRevisionId: rev1.id, provisional: true } } });
    expect(await pinSpecSource(wsA, { specSource: { specId: spec.id, specRevisionId: '00000000-0000-4000-8000-0000000000c1' } })).toMatchObject({ ok: false, status: 409 });
  });

  test('a spec in another workspace is not found, and nothing is pinned', async () => {
    const spec = await draft();
    await approveSpecRevision(user(admin), spec.id, { revision: 1, expectedVersion: 1 });
    expect(await pinSpecSource(wsB, { specSource: { specId: spec.id } })).toMatchObject({ ok: false, status: 404 });
  });

  test('a caller cannot forge the pin: the hash and revision come from the database', async () => {
    const spec = await draft();
    const a = await approveSpecRevision(user(admin), spec.id, { revision: 1, expectedVersion: 1 });
    if (!a.ok) throw new Error(a.error);
    const p = await pinSpecSource(wsA, { specSource: { specId: spec.id, contentHash: 'f'.repeat(64), revision: 1, provisional: true } });
    expect(p.ok && p.context.specSource).toMatchObject({ contentHash: sha(BODY_N), revision: 1 });
    expect(p.ok && (p.context.specSource as Record<string, unknown>).provisional).toBeUndefined();
  });

  test('a pin whose hash no longer matches is reported unavailable, never read as the spec', async () => {
    const spec = await draft();
    const a = await approveSpecRevision(user(admin), spec.id, { revision: 1, expectedVersion: 1 });
    if (!a.ok) throw new Error(a.error);
    expect(await readPinnedSpecRevision({ specId: spec.id, specRevisionId: a.revision.id, contentHash: 'f'.repeat(64) }))
      .toMatchObject({ ok: false });
    expect(await readPinnedSpecRevision({ specId: spec.id, specRevisionId: '00000000-0000-4000-8000-000000000000', contentHash: sha(BODY_N) }))
      .toMatchObject({ ok: false });
  });

  test('ungated work is untouched: no specSource, or a repo-doc specSource, passes through as is', async () => {
    const none = { baseBranch: 'dev' };
    expect(await pinSpecSource(wsA, none)).toEqual({ ok: true, context: none });
    const legacy = { specSource: { specPath: 'docs/specs/x.md', planningTaskId: '00000000-0000-4000-8000-0000000000b1' } };
    expect(await pinSpecSource(wsA, legacy)).toEqual({ ok: true, context: legacy });
    expect(await pinSpecSource(wsA, null)).toEqual({ ok: true, context: null });
  });
});
