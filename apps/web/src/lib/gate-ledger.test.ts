/**
 * The route-side wrapper over `recordGateEvent`.
 *
 * Two behaviours worth pinning: who the caller is attributed to, and what
 * happens to a gate that fires before its route has resolved a workspace — the
 * case that would otherwise leave the prose-gate lint (the three-week
 * false-positive) unattributable and therefore invisible all over again.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { gateFrictionSignature } from '@buildd/core/gate-friction-signature';

interface Recorded {
  gate: string;
  outcome: string;
  reason: string;
  workspaceId?: string | null;
  detail?: Record<string, unknown> | null;
  callerOrigin?: string | null;
}

let recorded: Recorded[] = [];
let recordShouldReject = false;

mock.module('@buildd/core/gate-events', () => ({
  GATE_SLUGS: { PROSE_GATE: 'prose_gate', TASK_PARAM_VOCABULARY: 'task_param_vocabulary', CLAIM_LOOP_DEFERRAL: 'claim_loop_deferral' },
  gateFrictionSignature,
  recordGateEvent: async (input: Recorded) => {
    if (recordShouldReject) throw new Error('ledger exploded');
    recorded.push(input);
    return 'row-1';
  },
  recordOrCoalesceDeferral: async (input: Recorded) => {
    if (recordShouldReject) throw new Error('ledger exploded');
    recorded.push(input);
    return 'row-1';
  },
}));

let workspaceLookup: { id: string } | null = null;
let lookupShouldThrow = false;
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: {
        findFirst: async () => {
          if (lookupShouldThrow) throw new Error('db down');
          return workspaceLookup;
        },
      },
    },
  },
}));
mock.module('@buildd/core/db/schema', () => ({
  workspaces: { id: 'id', name: 'name', repo: 'repo' },
}));

const { fireGateEvent, fireGateEventForWorkspaceRef, gateCallerOrigin } = await import('./gate-ledger');

/** The wrapper is fire-and-forget by design, so tests wait a microtask turn. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  recorded = [];
  recordShouldReject = false;
  workspaceLookup = null;
  lookupShouldThrow = false;
});

describe('gateCallerOrigin', () => {
  it('prefers worker over api — a worker token authenticates as an API account', () => {
    // Without this precedence, every agent-filed task is indistinguishable from
    // a human curl and "is this lint only firing on agents?" is unanswerable.
    expect(gateCallerOrigin({ apiAccount: { id: 'a' }, workerId: 'w-1' })).toBe('worker');
  });

  it('reports api, dashboard and system for the remaining doors', () => {
    expect(gateCallerOrigin({ apiAccount: { id: 'a' } })).toBe('api');
    expect(gateCallerOrigin({ user: { id: 'u' } })).toBe('dashboard');
    expect(gateCallerOrigin({})).toBe('system');
  });
});

describe('fireGateEvent', () => {
  it('records without the caller awaiting anything', async () => {
    fireGateEvent({ gate: 'prose_gate', surface: 'POST /api/tasks', outcome: 'warned', reason: 'x' });
    await settle();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].outcome).toBe('warned');
  });

  it('returns the gateFrictionSignature synchronously, so a caller can fold it into a 400 body', () => {
    const sig = fireGateEvent({ gate: 'prose_gate', surface: 'POST /api/tasks', outcome: 'rejected', reason: 'x' });
    expect(sig).toBe(gateFrictionSignature('prose_gate', 'x'));
  });

  it('does not produce an unhandled rejection when the writer itself throws', async () => {
    recordShouldReject = true;
    // Synchronous return is the contract: the route continues to its response
    // regardless of what the ledger does.
    expect(() =>
      fireGateEvent({ gate: 'prose_gate', surface: 'POST /api/tasks', outcome: 'warned', reason: 'x' }),
    ).not.toThrow();
    await settle();
    expect(recorded).toHaveLength(0);
  });
});

describe('fireGateEventForWorkspaceRef', () => {
  const input = {
    gate: 'task_param_vocabulary',
    surface: 'POST /api/tasks',
    outcome: 'rejected' as const,
    reason: 'kind must be one of: …',
  };

  it('passes a UUID through without a lookup', async () => {
    const uuid = '11111111-2222-4333-8444-555555555555';
    fireGateEventForWorkspaceRef(uuid, input);
    await settle();
    expect(recorded[0].workspaceId).toBe(uuid);
    expect(recorded[0].detail?.workspaceRef).toBe(uuid);
  });

  it('resolves a repo name so the row is attributable to a workspace', async () => {
    workspaceLookup = { id: 'ws-resolved' };
    fireGateEventForWorkspaceRef('buildd', input);
    await settle();
    expect(recorded[0].workspaceId).toBe('ws-resolved');
    expect(recorded[0].detail?.workspaceRef).toBe('buildd');
  });

  it('still records when the reference does not resolve, keeping the raw hint', async () => {
    workspaceLookup = null;
    fireGateEventForWorkspaceRef('no-such-repo', input);
    await settle();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].workspaceId).toBeNull();
    expect(recorded[0].detail?.workspaceRef).toBe('no-such-repo');
  });

  it('still records when the lookup itself fails', async () => {
    lookupShouldThrow = true;
    fireGateEventForWorkspaceRef('buildd', input);
    await settle();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].workspaceId).toBeNull();
  });

  it('falls back to a plain write when no reference was supplied', async () => {
    fireGateEventForWorkspaceRef(undefined, input);
    await settle();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].detail).toBeUndefined();
  });

  it('returns the gateFrictionSignature synchronously, without waiting on the background resolution', () => {
    const sig = fireGateEventForWorkspaceRef('buildd', input);
    expect(sig).toBe(gateFrictionSignature(input.gate, input.reason));
  });
});
