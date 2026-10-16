import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';
import type { FailureIncidentRecovery } from '@buildd/shared';
import type { StoredIncident } from '@/lib/failure-incident-store';
import type { IncidentVerdictView } from '@/lib/incident-view';

const mockAuth = mock(async () => null as any);
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuth }));
const mockUser = mock(async () => null as any);
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockUser }));
const mockAccess = mock(async () => true);
mock.module('@/lib/team-access', () => ({
  verifyAccountWorkspaceAccess: mockAccess,
  verifyWorkspaceAccess: mockAccess,
}));
mock.module('@/lib/team-timezone', () => ({ getViewerTimezone: async () => 'UTC' }));
const mockFind = mock(async () => ({ id: 'x', workspaceId: 'w' }) as any);
mock.module('@buildd/core/db', () => ({ db: { query: { failureIncidents: { findFirst: mockFind }, workspaces: { findFirst: async () => ({ teamId: 't1' }) } } } }));

// The production deps are swapped for an in-memory incident; everything else is the real code.
let row: StoredIncident;
let verdict: IncidentVerdictView | null;
const effects: string[] = [];
mock.module('./deps', () => ({
  productionIncidentActionDeps: () => ({
    port: {
      findById: async () => row,
      compareAndSwap: async (_id: string, version: number, next: Omit<StoredIncident, 'id' | 'version'>) => {
        if (version !== row.version) return null;
        row = { ...row, ...next, version: row.version + 1 };
        return row;
      },
    },
    reassess: async () => { effects.push('reassess'); return row; },
    loadVerdict: async () => verdict,
    regate: async () => { effects.push('regate'); },
    now: () => '2026-10-11T14:00:00.000Z',
  }),
}));

import { POST } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const AT = '2026-10-11T13:58:00.000Z';

function recovery(over: Partial<FailureIncidentRecovery> = {}): FailureIncidentRecovery {
  return {
    v: 1, generation: 2,
    cause: { reasonCode: 'path_overlap.cycle', rule: 'path_overlap_stall', ownership: 'workflow' },
    subjects: [{ kind: 'task', id: '1a2b3c4d-0000' }], blockers: [{ kind: 'pr', id: '77', state: 'open', observedAt: AT }],
    overlappingPaths: [], observation: { observedAt: AT, source: 'sweep', evidenceRevision: 'rev2' },
    firstSeenAt: AT, lastSeenAt: AT, lastProgressAt: null, owner: 'person', state: 'needs_decision',
    nextAction: { kind: 'decide', label: 'Choose one to stop.', key: 'recovery:x:g2' }, nextCheckAt: null,
    decision: {
      question: 'Task 1a2b3c4d and PR #77\'s fix are waiting on each other. Choose one to stop.',
      options: [
        { capability: 'cancel_attempt', label: 'Cancel the stale attempt', effect: 'Stops the attempt on PR #77.' },
        { capability: 'retry_recovery', label: 'Try again', effect: 'Buildd re-reads the facts with a fresh budget.' },
        { capability: 'dismiss', label: 'Leave both waiting', effect: 'Nothing changes; it leaves Needs You.' },
      ],
      recommended: 'cancel_attempt',
    },
    verification: { predicate: 'p', params: {} },
    budget: { spent: 3, limit: 3, deadlineAt: AT, spentKeys: ['k1', 'k2', 'k3'] }, attempts: [],
    ...over,
  };
}

function incident(over: Partial<StoredIncident> = {}): StoredIncident {
  return {
    id: ID, workspaceId: 'w', signature: 's', detectorVersion: 'v', rule: 'path_overlap_stall', reasonCode: 'path_overlap.no_progress',
    title: 't', severity: 'high', status: 'open', firstSeenAt: AT, lastSeenAt: AT, occurrenceCount: 1, recurrenceCount: 0,
    affectedRefs: { taskIds: ['1a2b3c4d-0000'], workerIds: [], prNumbers: [77] }, evidenceRefs: [], impact: {},
    lastAlertedAt: null, lastAlertSeverity: null, linkedFixTaskId: null, acknowledgedAt: null, resolvedAt: null,
    recovery: recovery(), version: 5, ...over,
  } as StoredIncident;
}

const call = (body: unknown, id = ID) =>
  POST(
    new NextRequest(`http://localhost/api/health/incidents/${id}/actions`, { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );

describe('POST /api/health/incidents/[id]/actions — the click-time re-check (spec §9)', () => {
  beforeEach(() => {
    mockAuth.mockImplementation(async () => null);
    mockUser.mockImplementation(async () => ({ id: 'u1' }));
    mockAccess.mockImplementation(async () => true);
    mockFind.mockImplementation(async () => ({ id: ID, workspaceId: 'w' }));
    row = incident();
    verdict = { owner: 'person', by: 'rule', rail: 'no_next_step', reason: 'x', generation: 2 };
    effects.length = 0;
  });

  it('401 without a session or key; 403 for a non-admin token', async () => {
    mockUser.mockImplementation(async () => null);
    expect((await call({ capability: 'dismiss', generation: 2 })).status).toBe(401);
    mockAuth.mockImplementation(async () => ({ id: 'a', level: 'worker', scopes: null }));
    expect((await call({ capability: 'dismiss', generation: 2 })).status).toBe(403);
  });

  it('404 when the incident is outside the caller\'s teams, before anything is re-read', async () => {
    mockAccess.mockImplementation(async () => false);
    expect((await call({ capability: 'dismiss', generation: 2 })).status).toBe(404);
    expect(effects).toEqual([]);
  });

  it('400 for a capability outside the closed set — never a generic merge or force start', async () => {
    for (const capability of ['merge', 'force_start', 'resolve']) {
      expect((await call({ capability, generation: 2 })).status).toBe(400);
    }
    expect(effects).toEqual([]);
  });

  it('dismiss on the current generation: re-observes, acknowledges, re-gates, returns the fresh projection', async () => {
    const res = await call({ capability: 'dismiss', generation: 2, evidenceRevision: 'rev2' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(row.status).toBe('acknowledged');
    expect(effects).toEqual(['reassess', 'regate']);
    expect(body.projection).toMatchObject({ needsYou: false, dismissed: true });
  });

  it('AC-7: a click on generation 2 when the incident is at generation 3 answers 409 with the fresh assessment and changes nothing', async () => {
    row = incident({ recovery: recovery({ generation: 3 }) });
    const res = await call({ capability: 'dismiss', generation: 2, evidenceRevision: 'rev2' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe('generation_changed');
    expect(body.projection.generation).toBe(3);
    expect(row.status).toBe('open');
    expect(effects).toEqual(['reassess']);
  });

  it('an option the fresh assessment no longer offers is refused (409), not applied', async () => {
    row = incident({ recovery: recovery({ state: 'waiting', owner: 'buildd', decision: undefined, nextCheckAt: '2026-10-11T14:20:00.000Z', nextAction: { kind: 'wait', label: 'Waiting for PR #77 to land.', key: 'k' } }) });
    const res = await call({ capability: 'dismiss', generation: 2 });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('not_offered');
    expect(row.status).toBe('open');
  });

  it('an option done where its subject lives is not applied here: 422 with the link', async () => {
    const res = await call({ capability: 'cancel_attempt', generation: 2 });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('not_applied_here');
    expect(row.status).toBe('open');
  });

  it('retry_recovery gives the cause a fresh budget, keeps the spent keys (I-4), then re-assesses', async () => {
    const res = await call({ capability: 'retry_recovery', generation: 2 });
    expect(res.status).toBe(200);
    expect(row.recovery?.budget.spent).toBe(0);
    expect(row.recovery?.budget.spentKeys).toEqual(['k1', 'k2', 'k3']);
    expect(effects).toEqual(['reassess', 'reassess', 'regate']);
  });

  it('a person verdict from an older generation does not make the click the person\'s', async () => {
    verdict = { owner: 'person', by: 'rule', rail: 'no_next_step', reason: 'x', generation: 1 };
    const res = await call({ capability: 'dismiss', generation: 2 });
    // The assessment still asks, so the option is offered; only Needs You membership follows the verdict.
    expect(res.status).toBe(200);
  });
});
