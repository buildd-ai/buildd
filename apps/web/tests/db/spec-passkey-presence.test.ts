/**
 * A team can require a passkey to approve, retire or restore a spec (Living
 * Spec b7fc9316 R-20, AC-19), against real Postgres and real WebAuthn
 * verification (@simplewebauthn/server over a software authenticator).
 *
 * - With the switch on, every dashboard path that approves (inbox row, confirm
 *   link, spec page, import confirm), retires or restores changes nothing until
 *   a passkey assertion verifies; with it, the act goes through (AC-19).
 * - A person with no passkey is told how to add one (AC-19).
 * - An assertion counts for the exact act it was issued for: replayed onto a
 *   different revision, another spec, another act or by another person, or a
 *   second time, it is refused and nothing changes.
 * - Off (the default), nothing asks for a passkey.
 * - The switch is an owner's, and needs the owner's own passkey either way;
 *   adding or removing a passkey under it needs an existing one.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';
import { softAuthenticator } from './soft-authenticator';

process.env.AUTH_SECRET ||= 'spec-passkey-presence-test-secret';

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision, confirmSpecApproval, approveFromInbox, specApprovalDeps } = await import('../../src/lib/specs/approval');
const { retireSpec, restoreSpec, confirmSpecStatusChange } = await import('../../src/lib/specs/retire');
const { confirmImportedSpecs } = await import('../../src/lib/specs/import');
const presence = await import('../../src/lib/passkeys/guard');
const { passkeyRelyingParty } = await import('../../src/lib/passkeys/config');
type PresencePin = import('../../src/lib/passkeys/binding').PresencePin;

const rand = () => Math.random().toString(36).slice(2, 10);
async function person(teamId: string, role: 'owner' | 'admin' | 'member') {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, ${role})`);
  return u.id;
}
const user = (userId: string) => ({ kind: 'user' as const, userId });
const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';

let team: string; let ws: string; let offTeam: string; let offWs: string;
let owner: string; let admin: string; let keyless: string; let offAdmin: string;
const oauth = (userId: string, teamId: string) => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId, workspaceIds: null, sessionUserId: userId } as any });
const { rpID, origin } = passkeyRelyingParty();
const keys = new Map<string, ReturnType<typeof softAuthenticator>>();

/** Register a passkey for `userId` through the real registration path. */
async function addPasskey(userId: string, proof?: unknown) {
  const auth = softAuthenticator(rpID, origin);
  const opts = await presence.issueRegistrationChallenge(userId);
  if (!opts.ok) throw new Error(opts.error);
  const r = await presence.registerPasskey(userId, { response: auth.register(opts.options), name: 'Laptop', presence: proof });
  if (!r.ok) throw new Error(`${r.code}: ${r.error}`);
  keys.set(userId, auth);
  return auth;
}
/** What the browser does after a presence_required refusal: ask for options over the pin, and assert. */
async function assertFor(userId: string, pin: PresencePin, opts: { present?: boolean; auth?: ReturnType<typeof softAuthenticator> } = {}) {
  const o = await presence.issuePresenceChallenge(userId, pin);
  if (!o.ok) throw new Error(o.error);
  return (opts.auth ?? keys.get(userId)!).assert(o.options, { present: opts.present });
}

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: team, workspaceId: ws } = await seedWorkspace());
  ({ teamId: offTeam, workspaceId: offWs } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id IN (${ws}::uuid, ${offWs}::uuid)`);
  owner = await person(team, 'owner');
  admin = await person(team, 'admin');
  keyless = await person(team, 'admin');
  offAdmin = await person(offTeam, 'admin');
  specApprovalDeps.notify = async () => {};
  // Passkeys first: once the team requires them, adding a second one needs the first.
  await addPasskey(owner);
  await addPasskey(admin);
  const on = await presence.setTeamPasskeyRequired(owner, team, true, await assertFor(owner, { op: 'team_passkey', teamId: team, required: true }));
  if (!on.ok) throw new Error(on.error);
});

async function draft(workspaceId = ws, by = admin) {
  const r = await createSpecDraft(user(by), { workspaceId, title: `Checkout ${rand()}`, body: `# Checkout ${rand()}\nR-1: Totals are in the shopper's currency ${rand()}.\n` }, { duplicates: false });
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}
async function row(specId: string) {
  const [r] = await q<{ status: string; version: number; head_revision: number; approved_revision: number | null }>(sql`
    SELECT status, version, head_revision, approved_revision FROM specs WHERE id = ${specId}::uuid`);
  return r;
}
async function pinOf(specId: string) {
  const s = await row(specId);
  const [h] = await q<{ content_hash: string }>(sql`SELECT content_hash FROM spec_revisions WHERE spec_id = ${specId}::uuid AND revision = ${s.head_revision}`);
  return { revision: s.head_revision, expectedVersion: s.version, contentHash: h.content_hash };
}
const approvePin = (specId: string, p: { revision: number; expectedVersion: number; contentHash: string }): PresencePin =>
  ({ op: 'approve', specId, revision: p.revision, version: p.expectedVersion, contentHash: p.contentHash });
const tokenOf = (url: string) => new URL(url).searchParams.get('request')!;

describe('AC-19: a team that requires a passkey', () => {
  test('Approve without completing the passkey changes nothing; completing it approves the revision', async () => {
    const s = await draft();
    const pin = await pinOf(s.id);
    const before = await row(s.id);

    const asked = await approveFromInbox(user(admin), s.id, pin);
    expect(asked).toMatchObject({ ok: false, status: 403, code: 'presence_required', presence: { pin: approvePin(s.id, pin) } });
    expect(await row(s.id)).toEqual(before);

    // The prompt is dismissed, or the key is touched with no one present: still nothing.
    const absent = await assertFor(admin, approvePin(s.id, pin), { present: false });
    expect(await approveFromInbox(user(admin), s.id, { ...pin, presence: absent })).toMatchObject({ ok: false, code: 'presence_failed' });
    expect(await row(s.id)).toEqual(before);

    const proof = await assertFor(admin, approvePin(s.id, pin));
    const done = await approveFromInbox(user(admin), s.id, { ...pin, presence: proof });
    expect(done).toMatchObject({ ok: true, already: false });
    expect(await row(s.id)).toMatchObject({ approved_revision: 1, status: 'approved' });
  });

  test('a person with no passkey is told how to add one, and nothing changes', async () => {
    const s = await draft();
    const pin = await pinOf(s.id);
    const r = await approveFromInbox(user(keyless), s.id, pin);
    expect(r).toMatchObject({ ok: false, status: 403, code: 'passkey_missing' });
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toContain('Settings › Profile › Passkeys');
    expect(r.presence?.addUrl).toContain('/app/settings/account#passkeys');
    expect((await row(s.id)).approved_revision).toBeNull();
  });

  test('the confirm link, the spec page and the import confirm are guarded the same way', async () => {
    // A confirm link asked for over MCP.
    const viaLink = await draft();
    const asked = await approveSpecRevision(oauth(admin, team), viaLink.id, { revision: 1, expectedVersion: 1 });
    if (!asked.ok || !('pending' in asked)) throw new Error('expected a pending approval');
    const token = tokenOf(asked.pending.confirmUrl);
    expect(await confirmSpecApproval(user(admin), viaLink.id, token)).toMatchObject({ ok: false, code: 'presence_required' });
    expect((await row(viaLink.id)).approved_revision).toBeNull();
    const linkPin = approvePin(viaLink.id, await pinOf(viaLink.id));
    expect(await confirmSpecApproval(user(admin), viaLink.id, token, { presence: await assertFor(admin, linkPin) })).toMatchObject({ ok: true });

    // The spec page's own Approve.
    const direct = await draft();
    expect(await approveSpecRevision(user(admin), direct.id, { revision: 1, expectedVersion: 1 })).toMatchObject({ ok: false, code: 'presence_required' });
    expect((await row(direct.id)).approved_revision).toBeNull();
    const directProof = await assertFor(admin, approvePin(direct.id, await pinOf(direct.id)));
    expect(await approveSpecRevision(user(admin), direct.id, { revision: 1, expectedVersion: 1, presence: directProof })).toMatchObject({ ok: true });

    // An import confirm approves specs: it asks once, over the batch, before reading the repo.
    const imported = await draft();
    await q(sql`UPDATE specs SET repo_source = ${JSON.stringify({ state: 'imported', revision: 1, path: 'docs/specs/x.md', commitSha: 'a'.repeat(40), blobSha: 'b'.repeat(40) })}::jsonb WHERE id = ${imported.id}::uuid`);
    let repoRead = 0;
    const deps = { repo: async () => { repoRead += 1; return null; } } as any;
    const before = await row(imported.id);
    expect(await confirmImportedSpecs(user(admin), { workspaceId: ws, specIds: [imported.id] }, deps)).toMatchObject({ ok: false, code: 'presence_required', presence: { pin: { op: 'confirm_import', workspaceId: ws, specIds: [imported.id] } } });
    expect([await row(imported.id), repoRead]).toEqual([before, 0]);
    const batchProof = await assertFor(admin, { op: 'confirm_import', workspaceId: ws, specIds: [imported.id] });
    // Past the passkey, the batch runs (here: no repo linked, so it is reported, not approved).
    expect(await confirmImportedSpecs(user(admin), { workspaceId: ws, specIds: [imported.id], presence: batchProof }, deps)).toMatchObject({ ok: true, result: { skipped: [{ reason: 'unavailable' }] } });
    expect(repoRead).toBe(1);
  });

  test('retire and restore, direct and confirmed from a link, need the passkey too', async () => {
    const s = await draft();
    const REASON = 'Folded into the checkout spec.';
    const r0 = await row(s.id);
    expect(await retireSpec(user(admin), s.id, { reason: REASON })).toMatchObject({ ok: false, code: 'presence_required' });
    expect(await row(s.id)).toEqual(r0);
    const retirePin: PresencePin = { op: 'retire', specId: s.id, version: r0.version, status: r0.status, supersededBy: null };
    expect(await retireSpec(user(admin), s.id, { reason: REASON, presence: await assertFor(admin, retirePin) })).toMatchObject({ ok: true, spec: { status: 'retired' } });

    // Restore, asked over MCP and confirmed on the dashboard.
    const asked = await restoreSpec(oauth(admin, team), s.id, {});
    if (!asked.ok || !('pending' in asked)) throw new Error('expected a pending restore');
    const r1 = await row(s.id);
    expect(await confirmSpecStatusChange(user(admin), s.id, tokenOf(asked.pending.confirmUrl))).toMatchObject({ ok: false, code: 'presence_required' });
    expect(await row(s.id)).toEqual(r1);
    // A retire assertion for the same spec and version is not a restore assertion.
    const wrongAct = await assertFor(admin, { op: 'retire', specId: s.id, version: r1.version, status: r1.status, supersededBy: null });
    expect(await confirmSpecStatusChange(user(admin), s.id, tokenOf(asked.pending.confirmUrl), { presence: wrongAct })).toMatchObject({ ok: false, code: 'presence_failed' });
    expect(await row(s.id)).toEqual(r1);
    const restorePin: PresencePin = { op: 'restore', specId: s.id, version: r1.version, status: r1.status };
    expect(await confirmSpecStatusChange(user(admin), s.id, tokenOf(asked.pending.confirmUrl), { presence: await assertFor(admin, restorePin) }))
      .toMatchObject({ ok: true, spec: { status: 'draft' } });
  });
});

describe('an assertion counts for the exact confirm it was issued for', () => {
  test('replayed onto a different revision of the same spec: refused, nothing changes', async () => {
    const s = await draft();
    const p1 = await pinOf(s.id);
    // The person is shown revision 1 and completes the passkey for it...
    const forRevision1 = await assertFor(admin, approvePin(s.id, p1));
    // ...and revision 2 lands before the click reaches the server.
    const r2 = await reviseSpecDraft(user(admin), s.id, { expectedVersion: p1.expectedVersion, body: `# Checkout\nR-1: Totals are in the shopper's currency.\nR-2: Rates are cached ${rand()}.\n`, changeSummary: 'Adds R-2.' });
    if (!r2.ok) throw new Error(r2.error);
    const p2 = await pinOf(s.id);
    const before = await row(s.id);
    const replay = await approveFromInbox(user(admin), s.id, { ...p2, presence: forRevision1 });
    expect(replay).toMatchObject({ ok: false, status: 403, code: 'presence_failed' });
    expect(await row(s.id)).toEqual(before);
    // The spec page path refuses it the same way.
    expect(await approveSpecRevision(user(admin), s.id, { revision: p2.revision, expectedVersion: p2.expectedVersion, presence: forRevision1 })).toMatchObject({ ok: false, code: 'presence_failed' });
    expect(await row(s.id)).toEqual(before);
    // An assertion for revision 2 approves revision 2.
    expect(await approveFromInbox(user(admin), s.id, { ...p2, presence: await assertFor(admin, approvePin(s.id, p2)) })).toMatchObject({ ok: true });
    expect((await row(s.id)).approved_revision).toBe(2);
  });

  test('on another spec, by another person, or a second time: refused', async () => {
    const a = await draft();
    const b = await draft();
    const pa = await pinOf(a.id);
    const pb = await pinOf(b.id);
    const forA = await assertFor(admin, approvePin(a.id, pa));
    expect(await approveFromInbox(user(admin), b.id, { ...pb, presence: forA })).toMatchObject({ ok: false, code: 'presence_failed' });
    expect((await row(b.id)).approved_revision).toBeNull();

    // The owner's own passkey over a challenge the admin was issued: not the owner's to answer.
    const issuedToAdmin = await presence.issuePresenceChallenge(admin, approvePin(b.id, pb));
    if (!issuedToAdmin.ok) throw new Error(issuedToAdmin.error);
    const ownersAnswer = keys.get(owner)!.assert(issuedToAdmin.options);
    expect(await approveFromInbox(user(owner), b.id, { ...pb, presence: ownersAnswer })).toMatchObject({ ok: false, code: 'presence_failed' });
    expect((await row(b.id)).approved_revision).toBeNull();

    // One challenge, one use.
    const once = await assertFor(admin, approvePin(b.id, pb));
    expect(await presence.verifyPresence(admin, approvePin(b.id, pb), once)).toBe(true);
    expect(await approveFromInbox(user(admin), b.id, { ...pb, presence: once })).toMatchObject({ ok: false, code: 'presence_failed' });
    expect((await row(b.id)).approved_revision).toBeNull();
  });

  test('a stale pin is reported as stale before any passkey is asked for, and spends none', async () => {
    const s = await draft();
    const p = await pinOf(s.id);
    const proof = await assertFor(admin, approvePin(s.id, p));
    expect(await approveFromInbox(user(admin), s.id, { ...p, expectedVersion: p.expectedVersion + 1, presence: proof })).toMatchObject({ ok: false, status: 409, code: 'stale' });
    // The same assertion still answers the pin it was issued for.
    expect(await approveFromInbox(user(admin), s.id, { ...p, presence: proof })).toMatchObject({ ok: true });
  });
});

describe('off by default', () => {
  test('a team that has not turned it on approves and retires without a passkey', async () => {
    const [t] = await q<{ spec_passkey_required: boolean }>(sql`SELECT spec_passkey_required FROM teams WHERE id = ${offTeam}::uuid`);
    expect(t.spec_passkey_required).toBe(false);
    const s = await draft(offWs, offAdmin);
    expect(await approveFromInbox(user(offAdmin), s.id, await pinOf(s.id))).toMatchObject({ ok: true });
    expect(await retireSpec(user(offAdmin), s.id, { reason: 'No longer needed here.' })).toMatchObject({ ok: true });
  });
});

describe('the switch and the passkeys themselves', () => {
  test('only an owner changes the switch, and only with their own passkey', async () => {
    expect(await presence.setTeamPasskeyRequired(admin, team, false, undefined)).toMatchObject({ ok: false, status: 403 });
    expect(await presence.setTeamPasskeyRequired(owner, team, false, undefined)).toMatchObject({ ok: false, code: 'presence_required' });
    // An assertion for turning it on does not turn it off.
    const wrong = await assertFor(owner, { op: 'team_passkey', teamId: team, required: true });
    expect(await presence.setTeamPasskeyRequired(owner, team, false, wrong)).toMatchObject({ ok: false, code: 'presence_failed' });
    const [t] = await q<{ spec_passkey_required: boolean }>(sql`SELECT spec_passkey_required FROM teams WHERE id = ${team}::uuid`);
    expect(t.spec_passkey_required).toBe(true);

    // An owner with no passkey cannot turn it on: they would be locked out of their own approvals.
    const lone = await seedWorkspace();
    const loneOwner = await person(lone.teamId, 'owner');
    expect(await presence.setTeamPasskeyRequired(loneOwner, lone.teamId, true, undefined)).toMatchObject({ ok: false, code: 'passkey_missing' });
  });

  test('under the switch, adding or removing a passkey needs one the person already has', async () => {
    const second = softAuthenticator(rpID, origin);
    const opts = await presence.issueRegistrationChallenge(admin);
    if (!opts.ok) throw new Error(opts.error);
    const response = second.register(opts.options);
    expect(await presence.registerPasskey(admin, { response, name: 'Phone' })).toMatchObject({ ok: false, code: 'presence_required', presence: { pin: { op: 'add_passkey' } } });
    // The registration challenge was not spent: the same response goes through with the first passkey's assertion.
    const added = await presence.registerPasskey(admin, { response, name: 'Phone', presence: await assertFor(admin, { op: 'add_passkey' }) });
    expect(added).toMatchObject({ ok: true, passkey: { name: 'Phone' } });
    if (!added.ok) throw new Error('unreachable');

    expect(await presence.removePasskey(admin, added.passkey.id, undefined)).toMatchObject({ ok: false, code: 'presence_required' });
    const proof = await assertFor(admin, { op: 'remove_passkey', passkeyId: added.passkey.id }, { auth: second });
    expect(await presence.removePasskey(admin, added.passkey.id, proof)).toMatchObject({ ok: true });
    expect((await presence.listPasskeys(admin)).map((k) => k.name)).toEqual(['Laptop']);
  });
});
