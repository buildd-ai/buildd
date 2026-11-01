import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/**
 * POST /api/missions/[id]/outcome: a person's choice of a completed mission's
 * primary outcome (Mission checks I-28 rule 1), stored on the What shipped record.
 */

const ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REPORT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let missionRow: any;
let recordRow: any;
let currentUser: any;
let updates: any[] = [];

mock.module('drizzle-orm', () => ({
  eq: (...a: any[]) => ({ _op: 'eq', a }),
}));
mock.module('@buildd/core/db/schema', () => ({
  missions: { id: 'missions.id' },
}));
mock.module('@buildd/core/db', () => ({
  db: { query: { missions: { findFirst: () => Promise.resolve(missionRow) } } },
}));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: () => Promise.resolve(currentUser) }));
mock.module('@/lib/team-access', () => ({ resolveAccountTeamIds: () => Promise.resolve(['team-1']) }));
// The store's own merge is `withPersonPrimaryOutcome` (mission-outcome.test.ts); here, what reaches it.
const { withPersonPrimaryOutcome } = await import('@/lib/mission-outcome');
mock.module('@/lib/mission-shipped-report', () => ({
  loadOutcomePool: () => Promise.resolve([{ id: REPORT, title: 'Findings', kind: 'report', taskId: 't-1' }]),
  storePersonPrimaryOutcome: async (_id: string, choice: { artifactId: string; chosenBy: string } | null) => {
    if (!recordRow) return 'no_record';
    const metadata = withPersonPrimaryOutcome(recordRow.metadata, choice);
    updates.push({ metadata });
    return { primaryOutcome: (metadata.shipped as any).primaryOutcome ?? null };
  },
}));

const { POST } = await import('./route');
const call = (body: unknown, id = ID) => POST(
  new NextRequest(`http://localhost/api/missions/${id}/outcome`, { method: 'POST', body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
);

beforeEach(() => {
  missionRow = { id: ID, teamId: 'team-1', status: 'completed' };
  recordRow = { id: 'record-1', metadata: { kind: 'mission_shipped_report', shipped: { version: 1, completedAt: 'x' } } };
  currentUser = { id: 'u-1' };
  updates = [];
});

describe('POST /api/missions/[id]/outcome', () => {
  it('stores a person’s choice on the record, keeping the rest', async () => {
    const res = await call({ artifactId: REPORT });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ primaryOutcome: { artifactId: REPORT, source: 'person', chosenBy: 'user:u-1' } });
    expect(updates[0].metadata.shipped).toEqual({ version: 1, completedAt: 'x', primaryOutcome: { artifactId: REPORT, source: 'person', chosenBy: 'user:u-1' } });
  });

  it('clears it with null', async () => {
    recordRow.metadata.shipped.primaryOutcome = { artifactId: REPORT, source: 'person' };
    const res = await call({ artifactId: null });
    expect(res.status).toBe(200);
    expect('primaryOutcome' in updates[0].metadata.shipped).toBe(false);
  });

  it('refuses an artifact outside the mission’s pool', async () => {
    expect((await call({ artifactId: OTHER })).status).toBe(400);
    expect(updates).toEqual([]);
  });

  it('is a person’s act: no session, no choice', async () => {
    currentUser = null;
    expect((await call({ artifactId: REPORT })).status).toBe(401);
  });

  it('404s another team’s mission and 409s one that is not completed or has no record', async () => {
    missionRow = { ...missionRow, teamId: 'other' };
    expect((await call({ artifactId: REPORT })).status).toBe(404);
    missionRow = { ...missionRow, teamId: 'team-1', status: 'active' };
    expect((await call({ artifactId: REPORT })).status).toBe(409);
    missionRow = { ...missionRow, status: 'completed' };
    recordRow = null;
    expect((await call({ artifactId: REPORT })).status).toBe(409);
    expect(updates).toEqual([]);
  });

  it('400s a body that is not an artifact id or null', async () => {
    expect((await call({ artifactId: 'latest' })).status).toBe(400);
    expect((await call({})).status).toBe(400);
  });
});
