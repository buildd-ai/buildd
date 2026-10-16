/**
 * What the spec approval confirm page shows, against real Postgres: the whole
 * revision being approved (for the rendered view) and its changes as numbered
 * rows (for the changes view). A first approval is every line added from
 * line 1; a later one is the diff against the approved revision.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

process.env.AUTH_SECRET ||= 'spec-approval-view-test-secret';

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision } = await import('../../src/lib/specs/approval');
const { approvalRequestView } = await import('../../src/lib/specs/approval-view');

const rand = () => Math.random().toString(36).slice(2, 10);
async function person(teamId: string, role: 'owner' | 'admin' | 'member') {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, ${role})`);
  return u.id;
}

let teamA: string; let wsA: string; let admin: string; let member: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${wsA}::uuid`);
  admin = await person(teamA, 'admin');
  member = await person(teamA, 'member');
});

const user = (userId: string) => ({ kind: 'user' as const, userId });
const ACCOUNT = '00000000-0000-4000-8000-0000000000a2';
const adminOAuth = () => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId: teamA, workspaceIds: null, sessionUserId: admin } as any });

const BODY = '# Checkout\nIntro.\n## Totals\nR-1: Totals are in the shopper currency.\n';

async function requestToken(specId: string, revision: number, expectedVersion: number) {
  const r = await approveSpecRevision(adminOAuth(), specId, { revision, expectedVersion });
  if (!r.ok || !('pending' in r)) throw new Error(`expected a pending request, got ${JSON.stringify(r)}`);
  return new URL(r.pending.confirmUrl).searchParams.get('request')!;
}

describe('approval confirm page view', () => {
  test('a first approval carries the whole body and every line added from line 1', async () => {
    const c = await createSpecDraft(user(member), { workspaceId: wsA, title: `Checkout ${rand()}`, body: BODY });
    if (!c.ok) throw new Error(c.error);
    const view = await approvalRequestView(admin, c.spec.id, await requestToken(c.spec.id, 1, 1));
    if (view.state !== 'ready') throw new Error(`expected ready, got ${view.state}`);
    expect(view.replaces).toBeNull();
    expect(view.body).toBe(BODY);
    expect(view.hunks.map((h) => h.path)).toEqual(['Checkout', 'Checkout > Totals']);
    expect(view.hunks[0].rows[0]).toEqual({ op: '+', oldLine: null, newLine: 1, text: '# Checkout' });
    expect(view.hunks.flatMap((h) => h.rows).every((r) => r.op === '+')).toBe(true);
  });

  test('a later approval shows the change against the approved revision, numbered in each', async () => {
    const c = await createSpecDraft(user(member), { workspaceId: wsA, title: `Checkout ${rand()}`, body: BODY });
    if (!c.ok) throw new Error(c.error);
    const a = await approveSpecRevision(user(admin), c.spec.id, { revision: 1, expectedVersion: 1 });
    if (!a.ok) throw new Error(a.error);
    const next = BODY.replace('shopper currency', 'currency the shopper picked');
    const r = await reviseSpecDraft(user(member), c.spec.id, { expectedVersion: a.spec.version, body: next });
    if (!r.ok) throw new Error(r.error);
    const view = await approvalRequestView(admin, c.spec.id, await requestToken(c.spec.id, 2, r.spec.version));
    if (view.state !== 'ready') throw new Error(`expected ready, got ${view.state}`);
    expect(view.replaces).toBe(1);
    expect(view.body).toBe(next);
    expect(view.hunks).toEqual([{
      kind: 'changed', path: 'Checkout > Totals', linesAdded: 1, linesRemoved: 1,
      rows: [
        { op: ' ', oldLine: 3, newLine: 3, text: '## Totals' },
        { op: '-', oldLine: 4, newLine: null, text: 'R-1: Totals are in the shopper currency.' },
        { op: '+', oldLine: null, newLine: 4, text: 'R-1: Totals are in the currency the shopper picked.' },
      ],
    }]);
  });
});
