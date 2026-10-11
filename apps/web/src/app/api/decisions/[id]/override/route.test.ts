import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const DECISION_ID = '11111111-1111-4111-8111-111111111111';
const USER = { id: 'user-1' };

let authed: { id: string } | null;
let record: { id: string; teamId: string } | null;
let teamIds: string[];
let overrideCalls: Array<{ id: string; override: unknown; by: string }>;

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => authed }));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => USER }));
mock.module('@/lib/team-access', () => ({ resolveAccountTeamIds: async () => teamIds }));
mock.module('@buildd/core/db/schema', () => ({ decisionRecords: { id: 'decision_records.id' } }));
mock.module('drizzle-orm', () => ({ eq: (f: unknown, v: unknown) => ({ f, v }) }));
mock.module('@buildd/core/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => (record ? [record] : []) }) }) }) },
}));
mock.module('@buildd/core/decision-ledger', () => ({
  recordHumanOverride: async (id: string, override: unknown, by: string) => { overrideCalls.push({ id, override, by }); },
}));

let outcomeCalls: unknown[] = [];
mock.module('@buildd/core/decision-outcomes', () => ({
  labelDecisionOutcome: async (i: unknown) => { outcomeCalls.push(i); return { ok: true, results: [] }; },
}));

import { POST } from './route';

const req = (body: unknown, apiKey: string | null = null) =>
  new NextRequest(`http://localhost/api/decisions/${DECISION_ID}/override`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const params = (id = DECISION_ID) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  authed = null;
  record = { id: DECISION_ID, teamId: 'team-1' };
  teamIds = ['team-1'];
  overrideCalls = [];
  outcomeCalls = [];
});

describe('POST /api/decisions/[id]/override', () => {
  it('404 for a non-UUID id', async () => {
    expect((await POST(req({ answer: 'x' }), params('nope'))).status).toBe(404);
  });

  it('401 with no session and no key', async () => {
    const r = new NextRequest(`http://localhost/api/decisions/${DECISION_ID}/override`, { method: 'POST', body: JSON.stringify({ answer: 'x' }) });
    mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => null }));
    expect((await POST(r, params())).status).toBe(401);
    mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => USER }));
  });

  it('400 without a non-blank answer', async () => {
    expect((await POST(req({}), params())).status).toBe(400);
    expect((await POST(req({ answer: '   ' }), params())).status).toBe(400);
    expect(overrideCalls).toEqual([]);
  });

  it('404 for an unknown decision', async () => {
    record = null;
    expect((await POST(req({ answer: 'UTC' }), params())).status).toBe(404);
  });

  it('404 when the caller\'s team does not own the decision (existence not disclosed)', async () => {
    teamIds = ['some-other-team'];
    expect((await POST(req({ answer: 'UTC' }), params())).status).toBe(404);
    expect(overrideCalls).toEqual([]);
  });

  it('records the override with the reason and the overriding user', async () => {
    const res = await POST(req({ answer: 'UTC', reason: 'customers are mostly US-based' }), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, decisionId: DECISION_ID });
    expect(overrideCalls).toEqual([{ id: DECISION_ID, override: { answer: 'UTC', reason: 'customers are mostly US-based' }, by: 'user-1' }]);
    expect(outcomeCalls).toEqual([{ teamId: 'team-1', decisionRecordId: DECISION_ID, source: 'human', label: 'overridden' }]);
  });

  it('drops a blank reason', async () => {
    await POST(req({ answer: 'UTC', reason: '  ' }), params());
    expect(overrideCalls[0].override).toEqual({ answer: 'UTC' });
  });
});
