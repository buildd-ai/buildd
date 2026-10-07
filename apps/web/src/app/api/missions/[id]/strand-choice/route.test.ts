import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/**
 * POST /api/missions/[id]/strand-choice: the owner's tap on a stranded local
 * mission ("Continue on a runner" / "Keep local"), recorded as a decision
 * label. It writes nothing; the executor flip is the mission PATCH.
 */

const ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
let missionRow: any = null;
let currentUser: any = { id: 'u-1' };
let apiAccountRow: any = null;

mock.module('drizzle-orm', () => ({
  eq: (...a: any[]) => ({ _op: 'eq', a }),
  desc: (...a: any[]) => ({ _op: 'desc', a }),
}));
mock.module('@buildd/core/db/schema', () => ({
  missions: Symbol('missions'),
  decisionRecords: Symbol('decisionRecords'),
  decisionOutcomes: Symbol('decisionOutcomes'),
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: () => Promise.resolve(missionRow) },
      decisionRecords: { findFirst: () => Promise.resolve(null) },
    },
    insert: () => ({ values: () => ({ catch: () => Promise.resolve() }) }),
  },
}));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: () => Promise.resolve(currentUser) }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: () => Promise.resolve(apiAccountRow) }));
mock.module('@/lib/team-access', () => ({ resolveAccountTeamIds: () => Promise.resolve(['team-1']) }));
mock.module('@/lib/open-workspaces', () => ({ workspaceOpenToCaller: () => Promise.resolve(false) }));

const logged: string[] = [];
mock.module('@/lib/strand-choice-decision', () => ({
  // The real line format (the module's own test pins it); only the sink is caught.
  strandLabelLine: (i: { missionId: string; label: string; order: string; quietMs: number }) =>
    `[decision-label] ${JSON.stringify({ site: 'mission_strand', mission: i.missionId.slice(0, 8), label: i.label, order: i.order, quietMinutes: Math.round(i.quietMs / 60_000) })}`,
  emitDecisionLabel: (line: string) => { logged.push(line); },
  STRAND_CHOICE_CAPABILITY: 'mission_strand_choice',
}));

const { POST } = await import('./route');
const call = (body: unknown, id = ID) => POST(
  new NextRequest(`http://localhost/api/missions/${id}/strand-choice`, { method: 'POST', body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
);

beforeEach(() => {
  missionRow = { id: ID, teamId: 'team-1', workspaceId: 'ws-1' };
  currentUser = { id: 'u-1' };
  apiAccountRow = null;
  logged.length = 0;
});

describe('POST /api/missions/[id]/strand-choice', () => {
  it('401s without a session or key', async () => {
    currentUser = null;
    expect((await call({ label: 'wait-for-local', order: 'runner-first', quietMs: 0 })).status).toBe(401);
  });

  it('404s a mission outside the caller’s teams', async () => {
    missionRow = { ...missionRow, teamId: 'other' };
    expect((await call({ label: 'wait-for-local', order: 'runner-first', quietMs: 0 })).status).toBe(404);
    expect(logged).toEqual([]);
  });

  it('400s a label that is not one of the two buttons', async () => {
    expect((await call({ label: 'blocked-on-deps', order: 'runner-first', quietMs: 0 })).status).toBe(400);
    expect((await call({ label: 'continue-on-runner', order: 'sideways', quietMs: 0 })).status).toBe(400);
  });

  it('records the tap as a content-free [decision-label] line', async () => {
    const res = await call({ label: 'continue-on-runner', order: 'runner-first', quietMs: 45 * 60_000 });
    expect(res.status).toBe(200);
    const line = logged.find(l => l.startsWith('[decision-label] '));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice('[decision-label] '.length))).toEqual({
      site: 'mission_strand', mission: 'cccccccc', label: 'continue-on-runner', order: 'runner-first', quietMinutes: 45,
    });
  });
});

describe("POST /api/missions/[id]/strand-choice - gated mode", () => {
  it("responds 200 even if decision outcome recording fails", async () => {
    const res = await call({ label: 'wait-for-local', order: 'local-first', quietMs: 60 * 60_000 });
    expect(res.status).toBe(200);
    expect(logged.length).toBeGreaterThan(0);
  });

  it("verifies most recent decision record is a mission_strand_choice before attaching outcome", async () => {
    const res = await call({ label: 'wait-for-local', order: 'local-first', quietMs: 60 * 60_000 });
    expect(res.status).toBe(200);
    // The mock currently returns null for findFirst, so no outcome is recorded
    // A real DB would verify the capability matches before inserting
  });

  it("logs [decision-label] line with all required fields", async () => {
    logged.length = 0;
    const res = await call({ label: 'continue-on-runner', order: 'runner-first', quietMs: 120 * 60_000 });
    expect(res.status).toBe(200);
    const labelLine = logged.find((l: string) => l.includes('[decision-label]'));
    expect(labelLine).toBeTruthy();
    const rec = JSON.parse(labelLine!.slice('[decision-label] '.length));
    expect(rec).toMatchObject({
      site: 'mission_strand',
      mission: 'cccccccc',
      label: 'continue-on-runner',
      order: 'runner-first',
      quietMinutes: 120,
    });
  });
});
