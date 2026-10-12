/**
 * Living Specs approval over MCP waits for the person (decision D-4, owner
 * decision 2026-10-11), against real Postgres: an approve from an OAuth bearer
 * session (MCP or chat, where an agent may be driving) writes nothing and
 * returns a signed link; the approval happens only when a person confirms it
 * from their dashboard session, at exactly the revision and version the
 * request named.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

process.env.AUTH_SECRET ||= 'spec-approval-confirm-test-secret';

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision, confirmSpecApproval } = await import('../../src/lib/specs/approval');
const { signSpecApprovalRequest, verifySpecApprovalRequest } = await import('../../src/lib/specs/approval-request');

const rand = () => Math.random().toString(36).slice(2, 10);
async function person(teamId: string, role: 'owner' | 'admin' | 'member') {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, ${role})`);
  return u.id;
}

let teamA: string; let wsA: string; let wsB: string;
let admin: string; let admin2: string; let member: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${wsA}::uuid`);
  ({ workspaceId: wsB } = await seedWorkspace());
  admin = await person(teamA, 'admin');
  admin2 = await person(teamA, 'owner');
  member = await person(teamA, 'member');
});

const user = (userId: string) => ({ kind: 'user' as const, userId });
const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
/** The admin's own OAuth MCP session: an agent may be the one typing. */
const adminOAuth = () => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId: teamA, workspaceIds: null, sessionUserId: admin } as any });

const BODY = '# Checkout\nR-1: Totals are in the shopper\'s currency.\n';

async function draft() {
  const r = await createSpecDraft(user(member), { workspaceId: wsA, title: `Checkout ${rand()}`, body: BODY });
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}
async function state(specId: string) {
  const [row] = await q<{ status: string; version: number; approved_revision: number | null; approved_by: string | null }>(sql`
    SELECT s.status, s.version, s.approved_revision, r.approved_by
    FROM specs s JOIN spec_revisions r ON r.spec_id = s.id AND r.revision = 1 WHERE s.id = ${specId}::uuid`);
  return row;
}
/** Ask over MCP, return the request token from the link. */
async function requestOverMcp(specId: string) {
  const r = await approveSpecRevision(adminOAuth(), specId, { revision: 1, expectedVersion: 1 });
  if (!r.ok || !('pending' in r)) throw new Error(`expected a pending request, got ${JSON.stringify(r)}`);
  return r.pending;
}

describe('an approve over MCP writes nothing and returns a link', () => {
  test('the admin\'s OAuth session gets a confirmation link; the spec is unchanged', async () => {
    const spec = await draft();
    const before = await state(spec.id);
    const pending = await requestOverMcp(spec.id);
    expect(pending.confirmUrl).toContain(`/app/specs/${spec.id}/approve?request=`);
    expect(pending.revision).toBe(1);
    expect(await state(spec.id)).toEqual(before);
    expect(before).toMatchObject({ approved_revision: null, approved_by: null });
  });

  test('the request token carries no secret beyond its signature and binds the revision and its hash', async () => {
    const spec = await draft();
    const pending = await requestOverMcp(spec.id);
    const token = new URL(pending.confirmUrl).searchParams.get('request')!;
    const v = verifySpecApprovalRequest(token);
    expect(v.ok && [v.payload.specId, v.payload.revision, v.payload.expectedVersion, v.payload.requestedBy]).toEqual([spec.id, 1, 1, admin]);
    expect(v.ok && v.payload.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('a person confirms it from their dashboard session', () => {
  test('confirming as the same person approves that revision; a second click changes nothing', async () => {
    const spec = await draft();
    const token = new URL((await requestOverMcp(spec.id)).confirmUrl).searchParams.get('request')!;
    const r = await confirmSpecApproval(user(admin), spec.id, token);
    expect(r.ok && [r.spec.status, r.spec.approvedRevision, 'already' in r ? r.already : false]).toEqual(['approved', 1, false]);
    const after = await state(spec.id);
    expect(after).toMatchObject({ approved_revision: 1, approved_by: `user:${admin}` });
    const again = await confirmSpecApproval(user(admin), spec.id, token);
    expect(again).toMatchObject({ ok: true, already: true });
    expect(await state(spec.id)).toEqual(after);
  });

  test('another owner or admin may confirm it; the approval names whoever confirmed', async () => {
    const spec = await draft();
    const token = new URL((await requestOverMcp(spec.id)).confirmUrl).searchParams.get('request')!;
    expect(await confirmSpecApproval(user(admin2), spec.id, token)).toMatchObject({ ok: true });
    expect(await state(spec.id)).toMatchObject({ approved_by: `user:${admin2}` });
  });

  test('a member without approval rights is refused; another team cannot see it; nothing is stamped', async () => {
    const spec = await draft();
    const token = new URL((await requestOverMcp(spec.id)).confirmUrl).searchParams.get('request')!;
    expect(await confirmSpecApproval(user(member), spec.id, token)).toMatchObject({ ok: false, status: 403 });
    const [{ team_id: teamB }] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${wsB}::uuid`);
    const outsider = await person(teamB, 'admin');
    expect(await confirmSpecApproval(user(outsider), spec.id, token)).toMatchObject({ ok: false, status: 404 });
    expect(await state(spec.id)).toMatchObject({ approved_revision: null, approved_by: null });
  });

  test('a bearer session cannot confirm, even the requesting person\'s own OAuth session', async () => {
    const spec = await draft();
    const token = new URL((await requestOverMcp(spec.id)).confirmUrl).searchParams.get('request')!;
    expect(await confirmSpecApproval(adminOAuth(), spec.id, token)).toMatchObject({ ok: false, status: 403 });
    expect(await state(spec.id)).toMatchObject({ approved_revision: null });
  });
});

describe('a request is for exactly what was asked', () => {
  test('a spec revised after the request is refused as stale, and nothing is written', async () => {
    const spec = await draft();
    const token = new URL((await requestOverMcp(spec.id)).confirmUrl).searchParams.get('request')!;
    const r2 = await reviseSpecDraft(user(member), spec.id, { expectedVersion: 1, body: BODY + 'R-2: Rates are cached.\n' });
    if (!r2.ok) throw new Error(r2.error);
    expect(await confirmSpecApproval(user(admin), spec.id, token)).toMatchObject({ ok: false, status: 409, code: 'request_stale' });
    const [row] = await q<{ approved_revision: number | null }>(sql`SELECT approved_revision FROM specs WHERE id = ${spec.id}::uuid`);
    expect(row.approved_revision).toBeNull();
  });

  test('an expired request is refused', async () => {
    const spec = await draft();
    const token = signSpecApprovalRequest({ specId: spec.id, workspaceId: wsA, revision: 1, expectedVersion: 1, contentHash: 'a'.repeat(64), requestedBy: admin }, Date.now() - 48 * 60 * 60 * 1000)!;
    expect(await confirmSpecApproval(user(admin), spec.id, token)).toMatchObject({ ok: false, status: 400, code: 'request_expired' });
  });

  test('a forged or tampered token, or one minted for another spec, is refused', async () => {
    const spec = await draft();
    const other = await draft();
    const token = new URL((await requestOverMcp(spec.id)).confirmUrl).searchParams.get('request')!;
    const [body, sig] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), revision: 2 })).toString('base64url')}.${sig}`;
    expect(await confirmSpecApproval(user(admin), spec.id, forged)).toMatchObject({ ok: false, status: 400, code: 'request_invalid' });
    expect(await confirmSpecApproval(user(admin), spec.id, 'not-a-token')).toMatchObject({ ok: false, status: 400, code: 'request_invalid' });
    expect(await confirmSpecApproval(user(admin), other.id, token)).toMatchObject({ ok: false, status: 400, code: 'request_invalid' });
    expect(await state(spec.id)).toMatchObject({ approved_revision: null });
    expect(await state(other.id)).toMatchObject({ approved_revision: null });
  });

  test('the dashboard\'s own approve is unchanged: a person in their session approves directly', async () => {
    const spec = await draft();
    const r = await approveSpecRevision(user(admin), spec.id, { revision: 1, expectedVersion: 1 });
    expect(r.ok && !('pending' in r) && r.spec.approvedRevision).toBe(1);
  });
});
